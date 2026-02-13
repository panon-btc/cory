use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_embed::Embed;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

use cory_core::cache::Cache;
use cory_core::enrich;
use cory_core::labels::{Bip329Type, LabelStore};
use cory_core::rpc::BitcoinRpc;
use cory_core::types::GraphLimits;

// ==============================================================================
// Application State
// ==============================================================================

pub struct AppState {
    pub rpc: Arc<dyn BitcoinRpc>,
    pub cache: Arc<Cache>,
    pub labels: Arc<RwLock<LabelStore>>,
    pub api_token: String,
    pub default_limits: GraphLimits,
    pub rpc_concurrency: usize,
    /// If set, local labels are persisted to this file on every mutation.
    pub local_labels_path: Option<PathBuf>,
}

type SharedState = Arc<AppState>;

// ==============================================================================
// Router
// ==============================================================================

pub fn build_router(state: AppState, origin: &str) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::exact(
            origin.parse().expect("valid origin header value"),
        ))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::HeaderName::from_static("x-api-token"),
        ]);

    let shared = Arc::new(state);

    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/graph/tx/{txid}", get(get_graph))
        .route("/api/v1/labels/import", post(import_labels))
        .route("/api/v1/labels/export", get(export_labels))
        .route("/api/v1/labels/set", post(set_label))
        .fallback(get(static_files))
        .layer(cors)
        .with_state(shared)
}

// ==============================================================================
// Handlers
// ==============================================================================

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

// -- Graph --------------------------------------------------------------------

#[derive(Deserialize)]
struct GraphQuery {
    max_depth: Option<usize>,
    max_nodes: Option<usize>,
    max_edges: Option<usize>,
}

/// Graph response extends the core `AncestryGraph` with enrichment data
/// (fees, RBF signaling, locktime info) and labels for each node.
#[derive(Serialize)]
struct GraphResponse {
    #[serde(flatten)]
    graph: cory_core::AncestryGraph,
    enrichments: std::collections::HashMap<String, TxEnrichment>,
    labels: std::collections::HashMap<String, Vec<LabelEntry>>,
}

#[derive(Serialize)]
struct TxEnrichment {
    fee_sats: Option<u64>,
    feerate_sat_vb: Option<f64>,
    rbf_signaling: bool,
    locktime: enrich::LocktimeInfo,
}

#[derive(Serialize)]
struct LabelEntry {
    namespace: String,
    label: String,
}

async fn get_graph(
    State(state): State<SharedState>,
    Path(txid_str): Path<String>,
    Query(query): Query<GraphQuery>,
) -> Result<Json<GraphResponse>, AppError> {
    let txid: bitcoin::Txid = txid_str
        .parse()
        .map_err(|e| AppError::BadRequest(format!("invalid txid: {e}")))?;

    let limits = GraphLimits {
        max_depth: query.max_depth.unwrap_or(state.default_limits.max_depth),
        max_nodes: query.max_nodes.unwrap_or(state.default_limits.max_nodes),
        max_edges: query.max_edges.unwrap_or(state.default_limits.max_edges),
    };

    let graph = cory_core::graph::build_ancestry(
        state.rpc.as_ref(),
        &state.cache,
        txid,
        &limits,
        state.rpc_concurrency,
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    // Compute enrichments and collect labels for each node.
    let mut enrichments = std::collections::HashMap::new();
    let mut labels_map = std::collections::HashMap::new();
    let label_store = state.labels.read().await;

    for (txid, node) in &graph.nodes {
        let fee = enrich::compute_fee(node);
        let feerate = fee.map(|f| enrich::compute_feerate(f, node.vsize));
        let has_non_final = node.inputs.iter().any(|i| i.sequence < 0xFFFFFFFF);

        enrichments.insert(
            txid.to_string(),
            TxEnrichment {
                fee_sats: fee.map(|f| f.to_sat()),
                feerate_sat_vb: feerate,
                rbf_signaling: enrich::is_rbf_signaling(node),
                locktime: enrich::locktime_info(node.locktime, has_non_final),
            },
        );

        let node_labels = label_store.get_all_labels_for_ref(&txid.to_string());
        if !node_labels.is_empty() {
            labels_map.insert(
                txid.to_string(),
                node_labels
                    .into_iter()
                    .map(|(ns, rec)| LabelEntry {
                        namespace: ns.to_string(),
                        label: rec.label,
                    })
                    .collect(),
            );
        }
    }

    Ok(Json(GraphResponse {
        graph,
        enrichments,
        labels: labels_map,
    }))
}

// -- Labels -------------------------------------------------------------------

async fn import_labels(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: String,
) -> Result<Json<serde_json::Value>, AppError> {
    check_auth(&state.api_token, &headers)?;

    let mut store = state.labels.write().await;
    let local_ns = store.local_namespace();
    store
        .import_bip329(&body, local_ns)
        .map_err(|e| AppError::BadRequest(e.to_string()))?;

    persist_labels(&state.local_labels_path, &store).await;

    Ok(Json(serde_json::json!({ "status": "imported" })))
}

async fn export_labels(State(state): State<SharedState>) -> Result<Response, AppError> {
    let store = state.labels.read().await;
    let content = store.export_local_bip329();

    Ok((
        StatusCode::OK,
        [
            (
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=\"labels.jsonl\"",
            ),
        ],
        content,
    )
        .into_response())
}

#[derive(Deserialize)]
struct SetLabelRequest {
    #[serde(rename = "type")]
    label_type: Bip329Type,
    #[serde(rename = "ref")]
    ref_id: String,
    label: String,
}

async fn set_label(
    State(state): State<SharedState>,
    headers: HeaderMap,
    req: Result<Json<SetLabelRequest>, JsonRejection>,
) -> Result<Json<serde_json::Value>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let Json(req) = req.map_err(|e| AppError::BadRequest(e.to_string()))?;

    let mut store = state.labels.write().await;
    store.set_label(req.label_type, req.ref_id, req.label);

    persist_labels(&state.local_labels_path, &store).await;

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ==============================================================================
// Static File Serving
// ==============================================================================

#[derive(Embed)]
#[folder = "ui/dist/"]
struct Assets;

/// Serves the embedded SPA. Exact file matches are returned with the correct
/// MIME type; everything else falls back to `index.html` for client-side routing.
async fn static_files(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Serve exact file if it exists
    if !path.is_empty() {
        if let Some(content) = Assets::get(path) {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            return (
                [(axum::http::header::CONTENT_TYPE, mime.as_ref())],
                content.data,
            )
                .into_response();
        }
    }
    // SPA fallback: serve index.html for all unmatched routes
    match Assets::get("index.html") {
        Some(content) => (
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            content.data,
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "UI not built. Run: cd ui && npm run build",
        )
            .into_response(),
    }
}

// ==============================================================================
// Helpers
// ==============================================================================

fn check_auth(expected_token: &str, headers: &HeaderMap) -> Result<(), AppError> {
    let token = headers
        .get("x-api-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if token != expected_token {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

/// Write the local namespace to disk if a persistence path is configured.
async fn persist_labels(path: &Option<PathBuf>, store: &LabelStore) {
    if let Some(path) = path {
        let exported = store.export_local_bip329();
        if let Err(e) = tokio::fs::write(path, &exported).await {
            tracing::warn!(path = %path.display(), error = %e, "could not persist labels to disk");
        }
    }
}

// ==============================================================================
// Error Type
// ==============================================================================

enum AppError {
    BadRequest(String),
    Unauthorized,
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "invalid or missing X-API-Token".into(),
            ),
            Self::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}
