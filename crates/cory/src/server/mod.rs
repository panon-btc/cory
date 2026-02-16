mod auth;
mod error;
mod graph;
mod labels;
mod static_files;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

use cory_core::cache::Cache;
use cory_core::labels::LabelStore;
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
    pub network: bitcoin::Network,
}

type SharedState = Arc<AppState>;

// ==============================================================================
// Router
// ==============================================================================

pub fn build_router(state: AppState, origin: &str) -> Router {
    // Only reflect the allowed origin when the request's Origin header
    // actually matches. Otherwise, omit the header entirely so browsers
    // get a clean CORS rejection instead of a mismatched origin value.
    let allowed: axum::http::HeaderValue = origin.parse().expect("valid origin header value");
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate({
            let allowed = allowed.clone();
            move |request_origin: &axum::http::HeaderValue, _| *request_origin == allowed
        }))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::HeaderName::from_static("x-api-token"),
        ]);

    let shared = Arc::new(state);

    let public_api = Router::new().route("/api/v1/health", get(health));

    // Label mutation routes get a 2 MB body limit to prevent abuse via
    // oversized import payloads. Graph and other routes use Axum's default.
    const LABEL_BODY_LIMIT: usize = 2 * 1024 * 1024;

    let label_routes = Router::new()
        .route(
            "/api/v1/label",
            get(labels::list_local_label_files).post(labels::create_or_import_local_label_file),
        )
        .route(
            "/api/v1/label/{file_id}",
            post(labels::upsert_or_replace_local_label_file)
                .delete(labels::delete_local_label_file),
        )
        .route(
            "/api/v1/label/{file_id}/entry",
            delete(labels::delete_local_label_entry),
        )
        .route(
            "/api/v1/label/{file_id}/export",
            get(labels::export_local_label_file),
        )
        .layer(DefaultBodyLimit::max(LABEL_BODY_LIMIT));

    let protected_api = Router::new()
        .route("/api/v1/graph/tx/{txid}", get(graph::get_graph))
        .route("/api/v1/labels.zip", get(labels::zip_browser_labels))
        .merge(label_routes);

    Router::new()
        .merge(public_api)
        .merge(protected_api)
        .fallback(static_files::static_files)
        .layer(cors)
        .with_state(shared)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}
