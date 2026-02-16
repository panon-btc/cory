//! Ancestry graph builder — BFS expansion of transaction spending history.
//!
//! Starting from a root transaction, the builder follows each input's
//! outpoint to its funding transaction, recursively, producing a DAG
//! of the spending ancestry bounded by configurable limits.

use std::collections::{HashMap, HashSet, VecDeque};

use bitcoin::Txid;
use futures::future::try_join_all;
use futures::stream::{self, StreamExt};
use tokio::sync::Semaphore;

use crate::cache::Cache;
use crate::error::CoreError;
use crate::rpc::BitcoinRpc;
use crate::types::{
    AncestryEdge, AncestryGraph, GraphLimits, GraphStats, ScriptType, TxInput, TxNode,
};

// ==============================================================================
// Ancestry Graph Builder
// ==============================================================================

/// Build a transaction spending ancestry DAG by BFS-expanding inputs.
///
/// Starting from `root_txid`, each transaction's non-coinbase inputs are
/// followed to their funding transactions, recursively, until coinbase
/// transactions or configured limits are reached. Transactions are deduped
/// by `txid`, producing a DAG (not a tree) when multiple inputs converge
/// on the same parent.
///
/// Frontier nodes at each BFS level are fetched in parallel, bounded by
/// the `concurrency` semaphore. This dramatically reduces wall-clock time
/// on wide graphs compared to sequential per-node fetching.
pub async fn build_ancestry(
    rpc: &dyn BitcoinRpc,
    cache: &Cache,
    root_txid: Txid,
    limits: &GraphLimits,
    concurrency: usize,
) -> Result<AncestryGraph, CoreError> {
    let semaphore = Semaphore::new(concurrency);
    let mut nodes: HashMap<Txid, TxNode> = HashMap::new();
    let mut edges: Vec<AncestryEdge> = Vec::new();
    let mut visited: HashSet<Txid> = HashSet::new();
    let mut truncated = false;
    let mut max_depth_reached: usize = 0;

    // BFS queue: (txid, depth from root).
    let mut queue: VecDeque<(Txid, usize)> = VecDeque::new();
    queue.push_back((root_txid, 0));

    while !queue.is_empty() {
        // Drain the current frontier: all txids at this BFS level.
        let mut frontier: Vec<(Txid, usize)> = Vec::new();
        while let Some((txid, depth)) = queue.pop_front() {
            if visited.contains(&txid) {
                continue;
            }
            if nodes.len() + frontier.len() >= limits.max_nodes {
                truncated = true;
                break;
            }
            if depth > limits.max_depth {
                truncated = true;
                continue;
            }
            if edges.len() >= limits.max_edges {
                truncated = true;
                break;
            }
            visited.insert(txid);
            frontier.push((txid, depth));
        }

        if frontier.is_empty() {
            break;
        }

        // Fetch all frontier nodes in parallel (semaphore limits concurrency).
        let frontier_txids: Vec<Txid> = frontier.iter().map(|(txid, _)| *txid).collect();
        let fetched_nodes = fetch_and_convert_many(rpc, cache, &semaphore, &frontier_txids).await?;

        // Process fetched nodes: add edges and enqueue next-level parents.
        for ((txid, depth), tx_node) in frontier.into_iter().zip(fetched_nodes) {
            if depth > max_depth_reached {
                max_depth_reached = depth;
            }

            if !tx_node.is_coinbase() {
                let candidate_edge_count = tx_node
                    .inputs
                    .iter()
                    .filter(|input| input.prevout.is_some())
                    .count();
                if edges.len() + candidate_edge_count > limits.max_edges {
                    nodes.insert(txid, tx_node);
                    truncated = true;
                    // Stop processing this frontier: remaining nodes are
                    // already visited so they won't be re-queued.
                    continue;
                }

                for (idx, input) in tx_node.inputs.iter().enumerate() {
                    if let Some(outpoint) = &input.prevout {
                        edges.push(AncestryEdge {
                            spending_txid: txid,
                            input_index: idx as u32,
                            funding_txid: outpoint.txid,
                            funding_vout: outpoint.vout,
                        });

                        if !visited.contains(&outpoint.txid) {
                            queue.push_back((outpoint.txid, depth + 1));
                        }
                    }
                }
            }

            nodes.insert(txid, tx_node);
        }
    }

    // After BFS is complete, many parent transactions are now present in `nodes`.
    // Backfill any still-unresolved input values from these in-graph parents so
    // fee computation works even when `gettxout` could not resolve spent outputs.
    backfill_inputs_from_graph(&mut nodes);

    Ok(AncestryGraph {
        stats: GraphStats {
            node_count: nodes.len(),
            edge_count: edges.len(),
            max_depth_reached,
        },
        nodes,
        edges,
        root_txid,
        truncated,
    })
}

// ==============================================================================
// Transaction Fetching and Conversion
// ==============================================================================

/// Fetch a transaction from the cache or RPC and enrich unresolved
/// inputs with prevout values/script types when possible.
async fn fetch_and_convert_many(
    rpc: &dyn BitcoinRpc,
    cache: &Cache,
    semaphore: &Semaphore,
    txids: &[Txid],
) -> Result<Vec<TxNode>, CoreError> {
    let mut ordered: Vec<Option<TxNode>> = vec![None; txids.len()];
    let mut missing_positions: Vec<usize> = Vec::new();
    let mut missing_txids: Vec<Txid> = Vec::new();

    // First try cache lookups so we only batch-fetch true misses.
    for (idx, txid) in txids.iter().enumerate() {
        if let Some(cached) = cache.get_tx(txid).await {
            ordered[idx] = Some(cached);
        } else {
            missing_positions.push(idx);
            missing_txids.push(*txid);
        }
    }

    if !missing_txids.is_empty() {
        let fetched = rpc.get_transactions(&missing_txids).await?;
        let enrich_futures: Vec<_> = fetched
            .into_iter()
            .map(|tx| enrich_and_cache_tx(rpc, cache, semaphore, tx))
            .collect();
        let enriched = try_join_all(enrich_futures).await?;

        for (position, tx_node) in missing_positions.into_iter().zip(enriched) {
            ordered[position] = Some(tx_node);
        }
    }

    Ok(ordered
        .into_iter()
        .map(|tx| tx.expect("all positions are filled from cache or RPC"))
        .collect())
}

/// Enrich and cache a fetched transaction, bounded by the shared semaphore.
async fn enrich_and_cache_tx(
    rpc: &dyn BitcoinRpc,
    cache: &Cache,
    semaphore: &Semaphore,
    tx: TxNode,
) -> Result<TxNode, CoreError> {
    let txid = tx.txid;

    // Double-check cache under semaphore in case another task already resolved it.
    let _permit = semaphore
        .acquire()
        .await
        .expect("semaphore is never closed");
    if let Some(cached) = cache.get_tx(&txid).await {
        return Ok(cached);
    }

    let tx_node = enrich_tx_node(rpc, cache, tx).await?;

    cache.insert_tx(txid, tx_node.clone()).await;
    Ok(tx_node)
}

/// Enrich a decoded transaction by resolving input prevout metadata.
/// When RPC already provided input value/script data (verbosity=2), we
/// use that directly; otherwise we resolve from caches and fallback RPC.
///
/// The conversion proceeds in three phases:
/// 1. Fill inputs from cache/local data, collecting unresolved
///    outpoints.
/// 2. Resolve unresolved prevouts via batched RPC, then batched
///    parent-tx fallback.
/// 3. Return the enriched transaction.
async fn enrich_tx_node(
    rpc: &dyn BitcoinRpc,
    cache: &Cache,
    mut tx: TxNode,
) -> Result<TxNode, CoreError> {
    // Phase 1: fill inputs from local data, track what still needs RPC.
    let unresolved = build_inputs_initial(cache, &mut tx.inputs).await;

    // Phase 2: resolve remaining inputs via batched gettxout + parent tx fallback.
    if !unresolved.is_empty() {
        resolve_unresolved_prevouts(rpc, cache, &mut tx.inputs, &unresolved, &tx.txid).await;
    }

    Ok(tx)
}

/// Phase 1: iterate inputs, resolve from local cache data where possible,
/// and return the outpoints that still need RPC resolution.
async fn build_inputs_initial(
    cache: &Cache,
    inputs: &mut [TxInput],
) -> Vec<(usize, bitcoin::OutPoint)> {
    stream::iter(inputs.iter_mut().enumerate())
        .then(|(idx, input)| async move {
            match &input.prevout {
                None => None,
                Some(outpoint) => match resolve_prevout_without_rpc(cache, input, outpoint).await {
                    Some((value, script_type)) => {
                        input.value = Some(value);
                        input.script_type = Some(script_type);
                        None
                    }
                    None => {
                        input.value = None;
                        input.script_type = None;
                        Some((idx, *outpoint))
                    }
                },
            }
        })
        .filter_map(std::future::ready)
        .collect()
        .await
}

/// Phase 2: for unresolved prevouts, first try a batched `gettxout` call,
/// then fall back to fetching parent transactions in batch for any that
/// remain unresolved (common for already-spent outputs).
async fn resolve_unresolved_prevouts(
    rpc: &dyn BitcoinRpc,
    cache: &Cache,
    inputs: &mut [TxInput],
    unresolved: &[(usize, bitcoin::OutPoint)],
    txid: &Txid,
) {
    let outpoints: Vec<bitcoin::OutPoint> = unresolved.iter().map(|(_, op)| *op).collect();

    // Batch gettxout — resolves unspent outputs in a single RPC call.
    match rpc.get_tx_outs(&outpoints).await {
        Ok(resolved) => {
            for ((input_idx, outpoint), info_opt) in unresolved.iter().zip(resolved) {
                // Skip unresolved outpoints that `gettxout` could not return
                let Some(info) = info_opt else {
                    continue;
                };

                // Cache the resolved output so future lookups can reuse it without an RPC call.
                cache
                    .insert_prevout(outpoint.txid, outpoint.vout, info.clone())
                    .await;

                // Backfill this transaction input with value/script metadata
                // from the resolved prevout.
                if let Some(input) = inputs.get_mut(*input_idx) {
                    input.value = Some(info.value);
                    input.script_type = Some(info.script_type);
                }
            }
        }
        Err(e) => {
            tracing::warn!(
                %txid,
                unresolved_count = outpoints.len(),
                error = %e,
                "batch gettxout failed; inputs will remain unresolved"
            );
        }
    }

    // Parent-tx fallback for still-unresolved inputs (spent outputs).
    let still_unresolved: Vec<usize> = inputs
        .iter()
        .enumerate()
        .filter(|(_, inp)| inp.value.is_none() && inp.prevout.is_some())
        .map(|(idx, _)| idx)
        .collect();

    let mut needed_parent_txids: Vec<Txid> = Vec::new();
    let mut needed_parent_set: HashSet<Txid> = HashSet::new();
    let mut indices_needing_parent: Vec<usize> = Vec::new();

    for idx in still_unresolved {
        let outpoint = inputs[idx]
            .prevout
            .expect("filtered for Some prevout above");

        if cache
            .get_prevout(&outpoint.txid, outpoint.vout)
            .await
            .is_some()
        {
            continue;
        }

        indices_needing_parent.push(idx);
        if needed_parent_set.insert(outpoint.txid) {
            needed_parent_txids.push(outpoint.txid);
        }
    }

    if needed_parent_txids.is_empty() {
        return;
    }

    if let Ok(parent_txs) = rpc.get_transactions(&needed_parent_txids).await {
        let parent_by_txid: HashMap<Txid, TxNode> =
            parent_txs.into_iter().map(|tx| (tx.txid, tx)).collect();

        for idx in indices_needing_parent {
            let outpoint = inputs[idx]
                .prevout
                .expect("input prevout exists for unresolved inputs");
            let Some(parent_tx) = parent_by_txid.get(&outpoint.txid) else {
                continue;
            };
            let Some(output) = parent_tx.outputs.get(outpoint.vout as usize) else {
                continue;
            };

            cache
                .insert_prevout(outpoint.txid, outpoint.vout, output.clone())
                .await;
            inputs[idx].value = Some(output.value);
            inputs[idx].script_type = Some(output.script_type);
        }
    }
}

/// Try to resolve the value and script type for a prevout using (in order):
/// 1. Data already present in the raw RPC response (verbosity=2)
/// 2. The prevout cache
/// 3. The transaction cache (the funding tx may already be fetched)
/// 4. The gettxout RPC call (last resort, only works for unspent outputs)
async fn resolve_prevout_without_rpc(
    cache: &Cache,
    input: &TxInput,
    outpoint: &bitcoin::OutPoint,
) -> Option<(bitcoin::Amount, ScriptType)> {
    // 1. Check if the RPC response already provided both fields.
    // We do not cache this path because `TxInput` intentionally does not
    // carry the prevout script bytes needed for `TxOutput.script_pub_key`.
    if let (Some(value), Some(script_type)) = (input.value, input.script_type) {
        return Some((value, script_type));
    }

    // 2. Check the prevout cache.
    if let Some(info) = cache.get_prevout(&outpoint.txid, outpoint.vout).await {
        return Some((info.value, info.script_type));
    }

    // 3. Check if the funding transaction is already in the tx cache.
    if let Some(funding_tx) = cache.get_tx(&outpoint.txid).await {
        if let Some(output) = funding_tx.outputs.get(outpoint.vout as usize) {
            cache
                .insert_prevout(outpoint.txid, outpoint.vout, output.clone())
                .await;
            return Some((output.value, output.script_type));
        }
    }

    // Could not resolve from local data; caller may try batched RPC.
    None
}

/// Fill unresolved input value/script metadata using parent transactions that are
/// already part of the built graph. This is intentionally post-build so children
/// fetched before their parents can still be enriched once the full BFS pass ends.
fn backfill_inputs_from_graph(nodes: &mut HashMap<Txid, TxNode>) {
    // Snapshot parent output data so we can mutate `nodes` safely afterwards.
    let funding_outputs: HashMap<Txid, Vec<(bitcoin::Amount, ScriptType)>> = nodes
        .iter()
        .map(|(txid, node)| {
            let outputs = node
                .outputs
                .iter()
                .map(|output| (output.value, output.script_type))
                .collect::<Vec<_>>();
            (*txid, outputs)
        })
        .collect();

    for node in nodes.values_mut() {
        for input in &mut node.inputs {
            if input.value.is_some() {
                continue;
            }
            let Some(outpoint) = input.prevout else {
                continue;
            };
            let Some(outputs) = funding_outputs.get(&outpoint.txid) else {
                continue;
            };
            let Some((value, script_type)) = outputs.get(outpoint.vout as usize) else {
                continue;
            };
            input.value = Some(*value);
            input.script_type = Some(*script_type);
        }
    }
}

// ==============================================================================
// Tests
// ==============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::mock::MockRpc;
    use crate::test_util::*;

    #[tokio::test]
    async fn three_node_chain() {
        // coinbase -> tx_a -> tx_b (root)
        let coinbase_txid = txid_from_byte(1);
        let tx_a_txid = txid_from_byte(2);
        let tx_b_txid = txid_from_byte(3);

        let coinbase = make_raw_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(5000)],
        );
        let tx_a = make_raw_tx(
            tx_a_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![simple_output(4000)],
        );
        let tx_b = make_raw_tx(
            tx_b_txid,
            vec![spending_input(tx_a_txid, 0)],
            vec![simple_output(3000)],
        );

        let rpc = MockRpc::builder()
            .with_tx(coinbase)
            .with_tx(tx_a)
            .with_tx(tx_b)
            .build();
        let cache = Cache::new();
        let limits = GraphLimits::default();

        let graph = build_ancestry(&rpc, &cache, tx_b_txid, &limits, 4)
            .await
            .expect("build ancestry");

        assert_eq!(graph.nodes.len(), 3, "should have 3 nodes");
        assert_eq!(graph.edges.len(), 2, "should have 2 edges");
        assert!(!graph.truncated, "should not be truncated");
        assert_eq!(graph.root_txid, tx_b_txid);
        assert_eq!(graph.stats.max_depth_reached, 2);
    }

    #[tokio::test]
    async fn depth_limit_truncates() {
        let coinbase_txid = txid_from_byte(1);
        let tx_a_txid = txid_from_byte(2);
        let tx_b_txid = txid_from_byte(3);

        let coinbase = make_raw_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(5000)],
        );
        let tx_a = make_raw_tx(
            tx_a_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![simple_output(4000)],
        );
        let tx_b = make_raw_tx(
            tx_b_txid,
            vec![spending_input(tx_a_txid, 0)],
            vec![simple_output(3000)],
        );

        let rpc = MockRpc::builder()
            .with_tx(coinbase)
            .with_tx(tx_a)
            .with_tx(tx_b)
            .build();
        let cache = Cache::new();
        let limits = GraphLimits {
            max_depth: 1,
            ..Default::default()
        };

        let graph = build_ancestry(&rpc, &cache, tx_b_txid, &limits, 4)
            .await
            .expect("build ancestry");

        // tx_b (depth 0) and tx_a (depth 1) are fetched, but coinbase (depth 2) is not.
        assert_eq!(graph.nodes.len(), 2, "should have 2 nodes (depth limited)");
        assert!(graph.truncated, "should be truncated");
    }

    #[tokio::test]
    async fn node_limit_truncates() {
        let coinbase_txid = txid_from_byte(1);
        let tx_a_txid = txid_from_byte(2);
        let tx_b_txid = txid_from_byte(3);

        let coinbase = make_raw_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(5000)],
        );
        let tx_a = make_raw_tx(
            tx_a_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![simple_output(4000)],
        );
        let tx_b = make_raw_tx(
            tx_b_txid,
            vec![spending_input(tx_a_txid, 0)],
            vec![simple_output(3000)],
        );

        let rpc = MockRpc::builder()
            .with_tx(coinbase)
            .with_tx(tx_a)
            .with_tx(tx_b)
            .build();
        let cache = Cache::new();
        let limits = GraphLimits {
            max_nodes: 2,
            ..Default::default()
        };

        let graph = build_ancestry(&rpc, &cache, tx_b_txid, &limits, 4)
            .await
            .expect("build ancestry");

        assert_eq!(graph.nodes.len(), 2, "should have 2 nodes (node limited)");
        assert!(graph.truncated, "should be truncated");
    }

    #[tokio::test]
    async fn dedup_shared_parent() {
        // Two inputs of the root tx spend different outputs of the same parent.
        //
        //   coinbase -> parent_tx --[vout 0]--> root_tx
        //                         \-[vout 1]-/
        let coinbase_txid = txid_from_byte(1);
        let parent_txid = txid_from_byte(2);
        let root_txid = txid_from_byte(3);

        let coinbase = make_raw_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(10000)],
        );

        let parent_out_0 = simple_output(4000);
        let parent_out_1 = simple_output(5000);

        let parent = make_raw_tx(
            parent_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![parent_out_0, parent_out_1],
        );
        let root = make_raw_tx(
            root_txid,
            vec![
                spending_input(parent_txid, 0),
                spending_input(parent_txid, 1),
            ],
            vec![simple_output(8000)],
        );

        let rpc = MockRpc::builder()
            .with_tx(coinbase)
            .with_tx(parent)
            .with_tx(root)
            .build();
        let cache = Cache::new();
        let limits = GraphLimits::default();

        let graph = build_ancestry(&rpc, &cache, root_txid, &limits, 4)
            .await
            .expect("build ancestry");

        // parent_tx should appear only once despite being referenced by two inputs.
        assert_eq!(graph.nodes.len(), 3, "should have 3 nodes (deduped)");
        // root has 2 edges to parent, parent has 1 edge to coinbase.
        assert_eq!(graph.edges.len(), 3, "should have 3 edges");
        assert!(!graph.truncated);
    }

    #[tokio::test]
    async fn edge_limit_truncates_without_partial_node_edges() {
        // root has 2 parent edges; max_edges=1 means we should truncate before
        // adding any of root's edges.
        let coinbase_txid = txid_from_byte(1);
        let parent_txid = txid_from_byte(2);
        let root_txid = txid_from_byte(3);

        let coinbase = make_raw_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(10_000)],
        );
        let parent_out_0 = simple_output(4_000);
        let parent_out_1 = simple_output(5_000);

        let parent = make_raw_tx(
            parent_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![parent_out_0, parent_out_1],
        );
        let root = make_raw_tx(
            root_txid,
            vec![
                spending_input(parent_txid, 0),
                spending_input(parent_txid, 1),
            ],
            vec![simple_output(8_000)],
        );

        let rpc = MockRpc::builder()
            .with_tx(coinbase)
            .with_tx(parent)
            .with_tx(root)
            .build();
        let cache = Cache::new();
        let limits = GraphLimits {
            max_edges: 1,
            ..Default::default()
        };

        let graph = build_ancestry(&rpc, &cache, root_txid, &limits, 4)
            .await
            .expect("build ancestry");

        assert!(graph.truncated, "should be truncated");
        assert_eq!(graph.nodes.len(), 1, "only root should be included");
        assert_eq!(
            graph.edges.len(),
            0,
            "no partial edges from truncated expansion should be emitted"
        );
    }
}
