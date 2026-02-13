use std::collections::{HashMap, HashSet, VecDeque};

use bitcoin::Txid;
use tokio::sync::Semaphore;

use crate::cache::{Cache, PrevoutInfo};
use crate::enrich::classify_script;
use crate::error::CoreError;
use crate::rpc::BitcoinRpc;
use crate::types::{
    AncestryEdge, AncestryGraph, GraphLimits, GraphStats, RawInputInfo, RawTxInfo, ScriptType,
    TxInput, TxNode, TxOutput,
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
/// The `concurrency` parameter controls how many RPC requests can be
/// in-flight simultaneously via a `tokio::sync::Semaphore`.
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

    while let Some((txid, depth)) = queue.pop_front() {
        if visited.contains(&txid) {
            continue;
        }

        // Check limits before expanding this node.
        if nodes.len() >= limits.max_nodes {
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
        if depth > max_depth_reached {
            max_depth_reached = depth;
        }

        // Fetch the transaction, preferring the cache.
        let tx_node = fetch_and_convert(rpc, cache, &semaphore, &txid).await?;

        // Enqueue funding transactions for non-coinbase inputs.
        if !tx_node.is_coinbase() {
            // Determine whether adding this node's parent edges would exceed
            // the configured edge cap. If so, truncate before adding any of
            // this node's edges to avoid partial-edge expansion.
            let candidate_edge_count = tx_node
                .inputs
                .iter()
                .filter(|input| input.prevout.is_some())
                .count();
            if edges.len() + candidate_edge_count > limits.max_edges {
                nodes.insert(txid, tx_node);
                truncated = true;
                break;
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

/// Fetch a transaction from the cache or RPC, converting the raw RPC
/// response into a `TxNode` with enriched inputs (prevout values and
/// script types).
async fn fetch_and_convert(
    rpc: &dyn BitcoinRpc,
    cache: &Cache,
    semaphore: &Semaphore,
    txid: &Txid,
) -> Result<TxNode, CoreError> {
    // Check the transaction cache first.
    if let Some(cached) = cache.get_tx(txid).await {
        return Ok(cached);
    }

    // Acquire a semaphore permit to limit concurrent RPC calls.
    let _permit = semaphore
        .acquire()
        .await
        .expect("semaphore is never closed");

    // Double-check after acquiring the permit (another task may have
    // populated the cache while we were waiting).
    if let Some(cached) = cache.get_tx(txid).await {
        return Ok(cached);
    }

    let raw = rpc.get_transaction(txid).await?;
    let tx_node = convert_raw_tx(rpc, cache, raw).await?;

    cache.insert_tx(*txid, tx_node.clone()).await;
    Ok(tx_node)
}

/// Convert a `RawTxInfo` into a `TxNode`, resolving prevout values and
/// script types for each input. When the raw response already includes
/// prevout data (verbosity=2), we use that directly; otherwise we look
/// up the funding transaction from the cache (which will have been fetched
/// during earlier BFS levels) or fall back to the prevout cache.
async fn convert_raw_tx(
    rpc: &dyn BitcoinRpc,
    cache: &Cache,
    raw: RawTxInfo,
) -> Result<TxNode, CoreError> {
    let mut inputs = Vec::with_capacity(raw.inputs.len());
    let mut unresolved_outpoints: Vec<(usize, bitcoin::OutPoint)> = Vec::new();

    for (idx, raw_input) in raw.inputs.iter().enumerate() {
        let (value, script_type) = match &raw_input.prevout {
            None => {
                // Coinbase input — no prevout to resolve.
                (None, None)
            }
            Some(outpoint) => match resolve_prevout_without_rpc(cache, raw_input, outpoint).await {
                Some((value, script_type)) => (Some(value), Some(script_type)),
                None => {
                    unresolved_outpoints.push((idx, *outpoint));
                    (None, None)
                }
            },
        };

        inputs.push(TxInput {
            prevout: raw_input.prevout,
            sequence: raw_input.sequence,
            value,
            script_type,
        });
    }

    // For unresolved prevouts, batch `gettxout` requests in one JSON-RPC call
    // when possible. This reduces per-input HTTP overhead on high-fan-in txs.
    if !unresolved_outpoints.is_empty() {
        let outpoints: Vec<bitcoin::OutPoint> = unresolved_outpoints
            .iter()
            .map(|(_, outpoint)| *outpoint)
            .collect();

        match rpc.get_tx_outs(&outpoints).await {
            Ok(resolved) => {
                for ((input_idx, outpoint), info_opt) in
                    unresolved_outpoints.into_iter().zip(resolved)
                {
                    if let Some(info) = info_opt {
                        let script_type = classify_script(info.script_pub_key.as_script());
                        cache
                            .insert_prevout(
                                outpoint.txid,
                                outpoint.vout,
                                PrevoutInfo {
                                    value: info.value,
                                    script_pub_key: info.script_pub_key,
                                    script_type,
                                },
                            )
                            .await;

                        if let Some(input) = inputs.get_mut(input_idx) {
                            input.value = Some(info.value);
                            input.script_type = Some(script_type);
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    txid = %raw.txid,
                    unresolved_count = outpoints.len(),
                    error = %e,
                    "batch gettxout failed; inputs will remain unresolved"
                );
            }
        }
    }

    let outputs: Vec<TxOutput> = raw
        .outputs
        .iter()
        .map(|o| TxOutput {
            value: o.value,
            script_pub_key: o.script_pub_key.clone(),
            script_type: classify_script(o.script_pub_key.as_script()),
        })
        .collect();

    Ok(TxNode {
        txid: raw.txid,
        version: raw.version,
        locktime: raw.locktime,
        size: raw.size,
        vsize: raw.vsize,
        weight: raw.weight,
        block_hash: raw.block_hash,
        block_height: raw.block_height,
        block_time: raw.block_time,
        inputs,
        outputs,
    })
}

/// Try to resolve the value and script type for a prevout using (in order):
/// 1. Data already present in the raw RPC response (verbosity=2)
/// 2. The prevout cache
/// 3. The transaction cache (the funding tx may already be fetched)
/// 4. The gettxout RPC call (last resort, only works for unspent outputs)
async fn resolve_prevout_without_rpc(
    cache: &Cache,
    raw_input: &RawInputInfo,
    outpoint: &bitcoin::OutPoint,
) -> Option<(bitcoin::Amount, ScriptType)> {
    // 1. Check if the raw response already has prevout info.
    if let (Some(value), Some(script)) = (&raw_input.prevout_value, &raw_input.prevout_script) {
        let st = classify_script(script.as_script());
        // Cache for future lookups.
        cache
            .insert_prevout(
                outpoint.txid,
                outpoint.vout,
                PrevoutInfo {
                    value: *value,
                    script_pub_key: script.clone(),
                    script_type: st,
                },
            )
            .await;
        return Some((*value, st));
    }

    // 2. Check the prevout cache.
    if let Some(info) = cache.get_prevout(&outpoint.txid, outpoint.vout).await {
        return Some((info.value, info.script_type));
    }

    // 3. Check if the funding transaction is already in the tx cache.
    if let Some(funding_tx) = cache.get_tx(&outpoint.txid).await {
        if let Some(output) = funding_tx.outputs.get(outpoint.vout as usize) {
            cache
                .insert_prevout(
                    outpoint.txid,
                    outpoint.vout,
                    PrevoutInfo {
                        value: output.value,
                        script_pub_key: output.script_pub_key.clone(),
                        script_type: output.script_type,
                    },
                )
                .await;
            return Some((output.value, output.script_type));
        }
    }

    // Could not resolve from local data; caller may try batched RPC.
    None
}

// ==============================================================================
// Tests
// ==============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::mock::MockRpc;
    use crate::types::RawOutputInfo;
    use bitcoin::hashes::Hash;
    use bitcoin::Amount;

    /// Helper to create a simple transaction for testing.
    fn make_tx(txid: Txid, inputs: Vec<RawInputInfo>, outputs: Vec<RawOutputInfo>) -> RawTxInfo {
        RawTxInfo {
            txid,
            version: 2,
            locktime: 0,
            size: 250,
            vsize: 140,
            weight: 560,
            block_hash: None,
            block_height: Some(100),
            block_time: Some(1_700_000_000),
            confirmations: Some(10),
            inputs,
            outputs,
        }
    }

    fn txid_from_byte(b: u8) -> Txid {
        let mut bytes = [0u8; 32];
        bytes[0] = b;
        Txid::from_byte_array(bytes)
    }

    fn coinbase_input() -> RawInputInfo {
        RawInputInfo {
            prevout: None,
            sequence: 0xFFFFFFFF,
            prevout_value: None,
            prevout_script: None,
        }
    }

    fn spending_input(funding_txid: Txid, vout: u32) -> RawInputInfo {
        RawInputInfo {
            prevout: Some(bitcoin::OutPoint::new(funding_txid, vout)),
            sequence: 0xFFFFFFFE,
            prevout_value: None,
            prevout_script: None,
        }
    }

    fn simple_output(sats: u64) -> RawOutputInfo {
        // Use a minimal valid p2wpkh scriptPubKey (OP_0 <20-byte-hash>).
        let script_bytes = [
            0x00, 0x14, // OP_0, PUSH20
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
        ];
        RawOutputInfo {
            value: Amount::from_sat(sats),
            script_pub_key: bitcoin::ScriptBuf::from_bytes(script_bytes.to_vec()),
            n: 0,
        }
    }

    #[tokio::test]
    async fn three_node_chain() {
        // coinbase -> tx_a -> tx_b (root)
        let coinbase_txid = txid_from_byte(1);
        let tx_a_txid = txid_from_byte(2);
        let tx_b_txid = txid_from_byte(3);

        let coinbase = make_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(5000)],
        );
        let tx_a = make_tx(
            tx_a_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![simple_output(4000)],
        );
        let tx_b = make_tx(
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

        let coinbase = make_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(5000)],
        );
        let tx_a = make_tx(
            tx_a_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![simple_output(4000)],
        );
        let tx_b = make_tx(
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

        let coinbase = make_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(5000)],
        );
        let tx_a = make_tx(
            tx_a_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![simple_output(4000)],
        );
        let tx_b = make_tx(
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

        let coinbase = make_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(10000)],
        );

        let mut parent_out_0 = simple_output(4000);
        parent_out_0.n = 0;
        let mut parent_out_1 = simple_output(5000);
        parent_out_1.n = 1;

        let parent = make_tx(
            parent_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![parent_out_0, parent_out_1],
        );
        let root = make_tx(
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

        let coinbase = make_tx(
            coinbase_txid,
            vec![coinbase_input()],
            vec![simple_output(10_000)],
        );
        let mut parent_out_0 = simple_output(4_000);
        parent_out_0.n = 0;
        let mut parent_out_1 = simple_output(5_000);
        parent_out_1.n = 1;

        let parent = make_tx(
            parent_txid,
            vec![spending_input(coinbase_txid, 0)],
            vec![parent_out_0, parent_out_1],
        );
        let root = make_tx(
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
