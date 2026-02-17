use axum::extract::State;
use axum::Json;
use serde::Serialize;

use super::SharedState;

// ==============================================================================
// Hard Ceilings for Graph Queries
// ==============================================================================
//
// These caps protect server resources regardless of CLI configuration.

pub(crate) const HARD_MAX_DEPTH: usize = 1000;
pub(crate) const HARD_MAX_NODES: usize = 50_000;
pub(crate) const HARD_MAX_EDGES: usize = 200_000;

#[derive(Serialize)]
pub(super) struct LimitsResponse {
    hard_max_depth: usize,
    configured_default_depth: usize,
    effective_default_depth: usize,
    hard_max_nodes: usize,
    configured_default_nodes: usize,
    effective_default_nodes: usize,
    hard_max_edges: usize,
    configured_default_edges: usize,
    effective_default_edges: usize,
}

pub(super) async fn get_limits(State(state): State<SharedState>) -> Json<LimitsResponse> {
    let configured_default_depth = state.default_limits.max_depth;
    let configured_default_nodes = state.default_limits.max_nodes;
    let configured_default_edges = state.default_limits.max_edges;

    Json(LimitsResponse {
        hard_max_depth: HARD_MAX_DEPTH,
        configured_default_depth,
        effective_default_depth: configured_default_depth.min(HARD_MAX_DEPTH),
        hard_max_nodes: HARD_MAX_NODES,
        configured_default_nodes,
        effective_default_nodes: configured_default_nodes.min(HARD_MAX_NODES),
        hard_max_edges: HARD_MAX_EDGES,
        configured_default_edges,
        effective_default_edges: configured_default_edges.min(HARD_MAX_EDGES),
    })
}
