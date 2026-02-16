use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Serialize;

use super::auth::check_auth;
use super::error::AppError;
use super::SharedState;

// ==============================================================================
// DTOs
// ==============================================================================

#[derive(Clone, Serialize)]
pub(super) struct HistoryEntry {
    txid: String,
    searched_at: String,
}

#[derive(Serialize)]
pub(super) struct HistoryResponse {
    entries: Vec<HistoryEntry>,
}

// ==============================================================================
// Handler
// ==============================================================================

pub(super) async fn get_history(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<HistoryResponse>, AppError> {
    check_auth(&state.api_token, &headers)?;

    let history = state.history.read().await;
    let mut entries: Vec<HistoryEntry> = history
        .iter()
        .map(|(txid, searched_at)| HistoryEntry {
            txid: txid.clone(),
            searched_at: searched_at.clone(),
        })
        .collect();

    // RFC3339 UTC strings are lexicographically sortable by recency.
    entries.sort_by(|a, b| b.searched_at.cmp(&a.searched_at));

    Ok(Json(HistoryResponse { entries }))
}
