use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use cory_core::enrich;
use cory_core::labels::{Bip329Record, Bip329Type, LabelFile, LabelFileKind, LabelStore};
use cory_core::types::GraphLimits;
use cory_core::AncestryGraph;

use super::auth::check_auth;
use super::error::AppError;
use super::limits::{HARD_MAX_DEPTH, HARD_MAX_EDGES, HARD_MAX_NODES};
use super::SharedState;

const MAX_HISTORY_ENTRIES: usize = 1000;

// ==============================================================================
// DTOs
// ==============================================================================

#[derive(Deserialize)]
pub(super) struct GraphQuery {
    max_depth: Option<usize>,
    max_nodes: Option<usize>,
    max_edges: Option<usize>,
}

/// Graph response extends the core `AncestryGraph` with enrichment data
/// (fees, RBF signaling, locktime info) and labels for each node.
#[derive(Serialize)]
pub(super) struct GraphResponse {
    #[serde(flatten)]
    graph: AncestryGraph,
    enrichments: HashMap<String, TxEnrichment>,
    labels_by_type: GraphLabelsByType,
    input_address_refs: HashMap<String, String>,
    output_address_refs: HashMap<String, String>,
    address_occurrences: HashMap<String, Vec<String>>,
}

#[derive(Serialize)]
pub(super) struct TxEnrichment {
    fee_sats: Option<u64>,
    feerate_sat_vb: Option<f64>,
    rbf_signaling: bool,
    locktime: enrich::LocktimeInfo,
}

#[derive(Serialize)]
pub(super) struct LabelEntry {
    file_id: String,
    file_name: String,
    file_kind: LabelFileKind,
    editable: bool,
    label: String,
}

#[derive(Default, Serialize)]
pub(super) struct GraphLabelsByType {
    tx: HashMap<String, Vec<LabelEntry>>,
    input: HashMap<String, Vec<LabelEntry>>,
    output: HashMap<String, Vec<LabelEntry>>,
    addr: HashMap<String, Vec<LabelEntry>>,
}

// ==============================================================================
// Handler
// ==============================================================================

pub(super) async fn get_graph(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(txid_str): Path<String>,
    Query(query): Query<GraphQuery>,
) -> Result<Json<GraphResponse>, AppError> {
    check_auth(&state.api_token, &headers)?;

    let txid: bitcoin::Txid = txid_str
        .parse()
        .map_err(|e| AppError::BadRequest(format!("invalid txid: {e}")))?;

    validate_limit_bounds("max_depth", query.max_depth, HARD_MAX_DEPTH)?;
    validate_limit_bounds("max_nodes", query.max_nodes, HARD_MAX_NODES)?;
    validate_limit_bounds("max_edges", query.max_edges, HARD_MAX_EDGES)?;

    let limits = GraphLimits {
        max_depth: query
            .max_depth
            .unwrap_or(state.default_limits.max_depth)
            .min(HARD_MAX_DEPTH),
        max_nodes: query
            .max_nodes
            .unwrap_or(state.default_limits.max_nodes)
            .min(HARD_MAX_NODES),
        max_edges: query
            .max_edges
            .unwrap_or(state.default_limits.max_edges)
            .min(HARD_MAX_EDGES),
    };

    let graph = cory_core::graph::build_ancestry(
        state.rpc.as_ref(),
        &state.cache,
        txid,
        &limits,
        state.rpc_concurrency,
    )
    .await
    .map_err(|e| map_graph_build_error(txid, e))?;

    // Record successful ancestry searches for the server-lifetime history panel.
    // Repeated txids overwrite their timestamp instead of creating duplicates.
    let searched_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|e| AppError::Internal(format!("format search timestamp: {e}")))?;
    let mut history = state.history.write().await;
    record_search_history(
        &mut history,
        txid.to_string(),
        searched_at,
        MAX_HISTORY_ENTRIES,
    );

    let label_store = state.labels.read().await;
    let enrichments = build_graph_enrichments(&graph, &label_store, state.network);

    Ok(Json(GraphResponse {
        graph,
        enrichments: enrichments.tx_enrichments,
        labels_by_type: enrichments.labels_by_type,
        input_address_refs: enrichments.input_address_refs,
        output_address_refs: enrichments.output_address_refs,
        address_occurrences: enrichments.address_occurrences,
    }))
}

// ==============================================================================
// Error Mapping and Validation Helpers
// ==============================================================================

fn validate_limit_bounds(field: &str, value: Option<usize>, max: usize) -> Result<(), AppError> {
    if let Some(limit) = value {
        if limit == 0 {
            return Err(AppError::BadRequest(format!("{field} must be at least 1")));
        }
        if limit > max {
            return Err(AppError::BadRequest(format!(
                "{field} must be at most {max}"
            )));
        }
    }
    Ok(())
}

fn map_graph_build_error(txid: bitcoin::Txid, err: cory_core::CoreError) -> AppError {
    match err {
        cory_core::CoreError::TxNotFound(_) => {
            AppError::NotFound(format!("transaction not found: {txid}"))
        }
        cory_core::CoreError::InvalidTxData(message) => AppError::BadRequest(message),
        cory_core::CoreError::Rpc(rpc) => AppError::BadGateway(format!("bitcoin rpc error: {rpc}")),
        other => AppError::Internal(format!("build ancestry graph for {txid}: {other}")),
    }
}

fn record_search_history(
    history: &mut HashMap<String, String>,
    txid: String,
    searched_at: String,
    max_entries: usize,
) {
    if let Some(existing) = history.get_mut(&txid) {
        *existing = searched_at;
        return;
    }

    if history.len() >= max_entries {
        // RFC3339 UTC strings sort chronologically; removing the smallest
        // timestamp evicts the oldest entry.
        if let Some(oldest_txid) = history
            .iter()
            .min_by(|a, b| a.1.cmp(b.1))
            .map(|(existing_txid, _)| existing_txid.clone())
        {
            history.remove(&oldest_txid);
        }
    }

    history.insert(txid, searched_at);
}

// ==============================================================================
// Enrichment Pipeline
// ==============================================================================

/// Aggregated enrichment data produced by scanning the graph's nodes and edges.
struct GraphEnrichments {
    tx_enrichments: HashMap<String, TxEnrichment>,
    labels_by_type: GraphLabelsByType,
    input_address_refs: HashMap<String, String>,
    output_address_refs: HashMap<String, String>,
    address_occurrences: HashMap<String, Vec<String>>,
}

/// Walks every node and edge in the graph to compute fee/RBF enrichments,
/// collect labels by type, and derive address references for inputs/outputs.
fn build_graph_enrichments(
    graph: &AncestryGraph,
    label_store: &LabelStore,
    network: bitcoin::Network,
) -> GraphEnrichments {
    let mut tx_enrichments = HashMap::new();
    let mut labels_by_type = GraphLabelsByType::default();
    let mut input_address_refs = HashMap::new();
    let mut output_address_refs = HashMap::new();
    let mut address_occurrences = HashMap::new();

    for (txid, node) in &graph.nodes {
        let txid_str = txid.to_string();
        let fee = enrich::compute_fee(node);
        let feerate = fee.map(|f| enrich::compute_feerate(f, node.vsize));
        let has_non_final = node.inputs.iter().any(|i| i.sequence < 0xFFFFFFFF);

        tx_enrichments.insert(
            txid_str.clone(),
            TxEnrichment {
                fee_sats: fee.map(|f| f.to_sat()),
                feerate_sat_vb: feerate,
                rbf_signaling: enrich::is_rbf_signaling(node),
                locktime: enrich::locktime_info(node.locktime, has_non_final),
            },
        );

        let tx_labels = label_store.get_all_labels_for(Bip329Type::Tx, &txid_str);
        if !tx_labels.is_empty() {
            labels_by_type
                .tx
                .insert(txid_str.clone(), to_label_entries(tx_labels));
        }

        for (vin, _) in node.inputs.iter().enumerate() {
            let input_ref = format!("{txid_str}:{vin}");
            let input_labels = label_store.get_all_labels_for(Bip329Type::Input, &input_ref);
            if !input_labels.is_empty() {
                labels_by_type
                    .input
                    .insert(input_ref, to_label_entries(input_labels));
            }
        }

        for (vout, output) in node.outputs.iter().enumerate() {
            let output_ref = format!("{txid_str}:{vout}");
            let output_labels = label_store.get_all_labels_for(Bip329Type::Output, &output_ref);
            if !output_labels.is_empty() {
                labels_by_type
                    .output
                    .insert(output_ref.clone(), to_label_entries(output_labels));
            }

            if let Ok(address) =
                bitcoin::Address::from_script(output.script_pub_key.as_script(), network)
            {
                let address_ref = address.to_string();
                output_address_refs.insert(output_ref.clone(), address_ref.clone());
                address_occurrences
                    .entry(address_ref.clone())
                    .or_insert_with(Vec::new)
                    .push(output_ref);

                if let std::collections::hash_map::Entry::Vacant(entry) =
                    labels_by_type.addr.entry(address_ref.clone())
                {
                    let addr_labels =
                        label_store.get_all_labels_for(Bip329Type::Addr, &address_ref);
                    if !addr_labels.is_empty() {
                        entry.insert(to_label_entries(addr_labels));
                    }
                }
            }
        }
    }

    // Derive input addresses from the edges that connect spending inputs
    // to their funding outputs.
    for edge in &graph.edges {
        let Some(funding_node) = graph.nodes.get(&edge.funding_txid) else {
            tracing::debug!(
                funding_txid = %edge.funding_txid,
                "skipping edge: funding node not in graph"
            );
            continue;
        };
        let Some(funding_output) = funding_node.outputs.get(edge.funding_vout as usize) else {
            tracing::debug!(
                funding_txid = %edge.funding_txid,
                funding_vout = edge.funding_vout,
                "skipping edge: funding output index out of range"
            );
            continue;
        };
        let Ok(address) =
            bitcoin::Address::from_script(funding_output.script_pub_key.as_script(), network)
        else {
            tracing::debug!(
                funding_txid = %edge.funding_txid,
                funding_vout = edge.funding_vout,
                "skipping edge: could not derive address from script"
            );
            continue;
        };
        let input_ref = format!("{}:{}", edge.spending_txid, edge.input_index);
        input_address_refs.insert(input_ref, address.to_string());
    }

    GraphEnrichments {
        tx_enrichments,
        labels_by_type,
        input_address_refs,
        output_address_refs,
        address_occurrences,
    }
}

// ==============================================================================
// Helpers
// ==============================================================================

fn to_label_entries(labels: Vec<(&LabelFile, &Bip329Record)>) -> Vec<LabelEntry> {
    labels
        .into_iter()
        .map(|(meta, rec)| LabelEntry {
            file_id: meta.id.clone(),
            file_name: meta.name.clone(),
            file_kind: meta.kind,
            editable: meta.editable,
            label: rec.label.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    #[test]
    fn validate_limit_bounds_rejects_zero() {
        let err =
            validate_limit_bounds("max_nodes", Some(0), 100).expect_err("zero limit must fail");
        let response = err.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn validate_limit_bounds_rejects_over_max() {
        let err = validate_limit_bounds("max_depth", Some(101), 100)
            .expect_err("limit above max must be rejected");
        let response = err.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn record_search_history_evicts_oldest_when_full() {
        let mut history = HashMap::new();
        record_search_history(
            &mut history,
            "old".to_string(),
            "2024-01-01T00:00:00Z".to_string(),
            2,
        );
        record_search_history(
            &mut history,
            "newer".to_string(),
            "2024-01-02T00:00:00Z".to_string(),
            2,
        );
        record_search_history(
            &mut history,
            "latest".to_string(),
            "2024-01-03T00:00:00Z".to_string(),
            2,
        );

        assert_eq!(history.len(), 2);
        assert!(!history.contains_key("old"));
        assert!(history.contains_key("newer"));
        assert!(history.contains_key("latest"));
    }

    #[test]
    fn record_search_history_updates_existing_entry_without_growth() {
        let mut history = HashMap::new();
        record_search_history(
            &mut history,
            "same".to_string(),
            "2024-01-01T00:00:00Z".to_string(),
            2,
        );
        record_search_history(
            &mut history,
            "same".to_string(),
            "2024-01-03T00:00:00Z".to_string(),
            2,
        );

        assert_eq!(history.len(), 1);
        assert_eq!(
            history.get("same").expect("existing key must be present"),
            "2024-01-03T00:00:00Z"
        );
    }
}
