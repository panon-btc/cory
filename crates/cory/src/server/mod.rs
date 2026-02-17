mod auth;
mod error;
mod graph;
mod history;
mod labels;
mod limits;
mod static_files;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{any, delete, get, post};
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
    pub history: Arc<RwLock<HashMap<String, String>>>,
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

    let public_api = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/limits", get(limits::get_limits));

    // Label mutation routes get a 2 MB body limit to prevent abuse via
    // oversized import payloads. Graph and other routes use Axum's default.
    const LABEL_BODY_LIMIT: usize = 2 * 1024 * 1024;

    let label_routes = Router::new()
        .route(
            "/api/v1/label",
            get(labels::list_label_files).post(labels::create_or_import_local_label_file),
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
        .route("/api/v1/history", get(history::get_history))
        .route("/api/v1/labels.zip", get(labels::zip_browser_labels))
        .merge(label_routes);

    Router::new()
        .merge(public_api)
        .merge(protected_api)
        .route("/api", any(api_not_found))
        .route("/api/{*path}", any(api_not_found))
        .fallback(static_files::static_files)
        .layer(cors)
        .with_state(shared)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn api_not_found() -> error::AppError {
    error::AppError::NotFound("API route not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use bitcoin::hashes::Hash;
    use bitcoin::{Amount, ScriptBuf, Txid};
    use cory_core::error::{CoreError, RpcError};
    use cory_core::types::{ScriptType, TxInput, TxNode, TxOutput};
    use tower::ServiceExt;

    #[derive(Clone, Copy)]
    enum FakeRpcMode {
        Ok,
        NotFound,
        InvalidTxData,
        RpcFailure,
    }

    struct FakeRpc {
        mode: FakeRpcMode,
    }

    #[async_trait]
    impl BitcoinRpc for FakeRpc {
        async fn get_transaction(&self, txid: &Txid) -> Result<TxNode, CoreError> {
            match self.mode {
                FakeRpcMode::Ok => Ok(sample_tx(*txid)),
                FakeRpcMode::NotFound => Err(CoreError::TxNotFound(*txid)),
                FakeRpcMode::InvalidTxData => {
                    Err(CoreError::InvalidTxData("invalid tx fixture".to_string()))
                }
                FakeRpcMode::RpcFailure => Err(CoreError::Rpc(RpcError::ServerError {
                    code: -28,
                    message: "Loading block index...".to_string(),
                })),
            }
        }

        async fn get_tx_out(
            &self,
            _txid: &Txid,
            _vout: u32,
        ) -> Result<Option<TxOutput>, CoreError> {
            Ok(None)
        }

        async fn get_blockchain_info(&self) -> Result<cory_core::rpc::ChainInfo, CoreError> {
            Ok(cory_core::rpc::ChainInfo {
                chain: "regtest".to_string(),
                blocks: 1,
                best_block_hash: bitcoin::BlockHash::all_zeros(),
                pruned: false,
            })
        }
    }

    fn sample_tx(txid: Txid) -> TxNode {
        TxNode {
            txid,
            version: 2,
            locktime: 0,
            size: 100,
            vsize: 100,
            weight: 400,
            block_hash: None,
            block_height: None,
            inputs: vec![TxInput {
                prevout: None,
                sequence: 0xFFFF_FFFF,
                value: None,
                script_type: None,
            }],
            outputs: vec![TxOutput {
                value: Amount::from_sat(1_000),
                script_pub_key: ScriptBuf::new(),
                script_type: ScriptType::Unknown,
            }],
        }
    }

    fn test_router(mode: FakeRpcMode) -> Router {
        test_router_with_limits(mode, GraphLimits::default())
    }

    fn test_router_with_limits(mode: FakeRpcMode, default_limits: GraphLimits) -> Router {
        let state = AppState {
            rpc: Arc::new(FakeRpc { mode }),
            cache: Arc::new(Cache::with_capacity(100, 100)),
            labels: Arc::new(RwLock::new(LabelStore::new())),
            api_token: "test-token".to_string(),
            default_limits,
            rpc_concurrency: 4,
            network: bitcoin::Network::Regtest,
            history: Arc::new(RwLock::new(HashMap::new())),
        };
        build_router(state, "http://127.0.0.1:3080")
    }

    fn txid_str(byte: u8) -> String {
        Txid::from_slice(&[byte; 32])
            .expect("test txid bytes must parse")
            .to_string()
    }

    async fn response_body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .expect("response body must be readable");
        serde_json::from_slice(&bytes).expect("response body must be valid JSON")
    }

    #[tokio::test]
    async fn unknown_api_route_returns_json_404() {
        let router = test_router(FakeRpcMode::Ok);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/does-not-exist")
                    .body(Body::empty())
                    .expect("request must build"),
            )
            .await
            .expect("router should serve request");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let json = response_body_json(response).await;
        assert_eq!(
            json.get("error").and_then(serde_json::Value::as_str),
            Some("API route not found")
        );
    }

    #[tokio::test]
    async fn limits_endpoint_exposes_hard_configured_and_effective_values() {
        let router = test_router_with_limits(
            FakeRpcMode::Ok,
            GraphLimits {
                max_depth: 5_000,
                max_nodes: 80_000,
                max_edges: 300_000,
            },
        );
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/limits")
                    .body(Body::empty())
                    .expect("request must build"),
            )
            .await
            .expect("router should serve request");

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_body_json(response).await;

        assert_eq!(
            json.get("hard_max_depth")
                .and_then(serde_json::Value::as_u64),
            Some(limits::HARD_MAX_DEPTH as u64)
        );
        assert_eq!(
            json.get("configured_default_depth")
                .and_then(serde_json::Value::as_u64),
            Some(5_000)
        );
        assert_eq!(
            json.get("effective_default_depth")
                .and_then(serde_json::Value::as_u64),
            Some(limits::HARD_MAX_DEPTH as u64)
        );

        assert_eq!(
            json.get("hard_max_nodes")
                .and_then(serde_json::Value::as_u64),
            Some(limits::HARD_MAX_NODES as u64)
        );
        assert_eq!(
            json.get("configured_default_nodes")
                .and_then(serde_json::Value::as_u64),
            Some(80_000)
        );
        assert_eq!(
            json.get("effective_default_nodes")
                .and_then(serde_json::Value::as_u64),
            Some(limits::HARD_MAX_NODES as u64)
        );

        assert_eq!(
            json.get("hard_max_edges")
                .and_then(serde_json::Value::as_u64),
            Some(limits::HARD_MAX_EDGES as u64)
        );
        assert_eq!(
            json.get("configured_default_edges")
                .and_then(serde_json::Value::as_u64),
            Some(300_000)
        );
        assert_eq!(
            json.get("effective_default_edges")
                .and_then(serde_json::Value::as_u64),
            Some(limits::HARD_MAX_EDGES as u64)
        );
    }

    #[tokio::test]
    async fn graph_zero_limits_return_bad_request() {
        let router = test_router(FakeRpcMode::Ok);
        let url = format!("/api/v1/graph/tx/{}?max_nodes=0", txid_str(1));
        let response = router
            .oneshot(
                Request::builder()
                    .uri(url)
                    .header("x-api-token", "test-token")
                    .body(Body::empty())
                    .expect("request must build"),
            )
            .await
            .expect("router should serve request");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let json = response_body_json(response).await;
        assert_eq!(
            json.get("error").and_then(serde_json::Value::as_str),
            Some("max_nodes must be at least 1")
        );
    }

    #[tokio::test]
    async fn graph_limit_above_configured_max_returns_bad_request() {
        let router = test_router_with_limits(
            FakeRpcMode::Ok,
            GraphLimits {
                max_depth: 2,
                max_nodes: 500,
                max_edges: 2000,
            },
        );
        let url = format!("/api/v1/graph/tx/{}?max_depth={}", txid_str(1), 3);
        let response = router
            .oneshot(
                Request::builder()
                    .uri(url)
                    .header("x-api-token", "test-token")
                    .body(Body::empty())
                    .expect("request must build"),
            )
            .await
            .expect("router should serve request");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let json = response_body_json(response).await;
        assert_eq!(
            json.get("error").and_then(serde_json::Value::as_str),
            Some("max_depth must be at most 2")
        );
    }

    #[tokio::test]
    async fn graph_tx_not_found_maps_to_404() {
        let router = test_router(FakeRpcMode::NotFound);
        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/graph/tx/{}", txid_str(2)))
                    .header("x-api-token", "test-token")
                    .body(Body::empty())
                    .expect("request must build"),
            )
            .await
            .expect("router should serve request");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn graph_invalid_tx_data_maps_to_400() {
        let router = test_router(FakeRpcMode::InvalidTxData);
        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/graph/tx/{}", txid_str(3)))
                    .header("x-api-token", "test-token")
                    .body(Body::empty())
                    .expect("request must build"),
            )
            .await
            .expect("router should serve request");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn graph_rpc_failure_maps_to_502() {
        let router = test_router(FakeRpcMode::RpcFailure);
        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/graph/tx/{}", txid_str(4)))
                    .header("x-api-token", "test-token")
                    .body(Body::empty())
                    .expect("request must build"),
            )
            .await
            .expect("router should serve request");

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }
}
