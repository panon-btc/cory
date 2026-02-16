use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rust_embed::Embed;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

use cory_core::cache::Cache;
use cory_core::enrich;
use cory_core::labels::{Bip329Type, LabelFile, LabelFileKind, LabelStore, LabelStoreError};
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
            get(list_local_label_files).post(create_or_import_local_label_file),
        )
        .route(
            "/api/v1/label/{file_id}",
            post(upsert_or_replace_local_label_file).delete(delete_local_label_file),
        )
        .route(
            "/api/v1/label/{file_id}/entry",
            delete(delete_local_label_entry),
        )
        .route(
            "/api/v1/label/{file_id}/export",
            get(export_local_label_file),
        )
        .layer(DefaultBodyLimit::max(LABEL_BODY_LIMIT));

    let protected_api = Router::new()
        .route("/api/v1/graph/tx/{txid}", get(get_graph))
        .merge(label_routes);

    Router::new()
        .merge(public_api)
        .merge(protected_api)
        .fallback(static_files)
        .layer(cors)
        .with_state(shared)
}

// ==============================================================================
// Hard Ceilings for Graph Queries
// ==============================================================================
//
// These prevent clients from requesting arbitrarily large graphs that would
// exhaust server resources, regardless of what the CLI defaults are.

const MAX_GRAPH_DEPTH: usize = 200;
const MAX_GRAPH_NODES: usize = 5_000;
const MAX_GRAPH_EDGES: usize = 20_000;

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
    labels_by_type: GraphLabelsByType,
    input_address_refs: std::collections::HashMap<String, String>,
    output_address_refs: std::collections::HashMap<String, String>,
    address_occurrences: std::collections::HashMap<String, Vec<String>>,
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
    file_id: String,
    file_name: String,
    file_kind: LabelFileKind,
    editable: bool,
    label: String,
}

#[derive(Serialize)]
struct LabelFileSummary {
    id: String,
    name: String,
    kind: LabelFileKind,
    editable: bool,
    record_count: usize,
}

#[derive(Default, Serialize)]
struct GraphLabelsByType {
    tx: std::collections::HashMap<String, Vec<LabelEntry>>,
    input: std::collections::HashMap<String, Vec<LabelEntry>>,
    output: std::collections::HashMap<String, Vec<LabelEntry>>,
    addr: std::collections::HashMap<String, Vec<LabelEntry>>,
}

async fn get_graph(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(txid_str): Path<String>,
    Query(query): Query<GraphQuery>,
) -> Result<Json<GraphResponse>, AppError> {
    check_auth(&state.api_token, &headers)?;

    let txid: bitcoin::Txid = txid_str
        .parse()
        .map_err(|e| AppError::BadRequest(format!("invalid txid: {e}")))?;

    let limits = GraphLimits {
        max_depth: query
            .max_depth
            .unwrap_or(state.default_limits.max_depth)
            .min(MAX_GRAPH_DEPTH),
        max_nodes: query
            .max_nodes
            .unwrap_or(state.default_limits.max_nodes)
            .min(MAX_GRAPH_NODES),
        max_edges: query
            .max_edges
            .unwrap_or(state.default_limits.max_edges)
            .min(MAX_GRAPH_EDGES),
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

    // Compute enrichments and collect labels for each target type.
    let mut enrichments = std::collections::HashMap::new();
    let mut labels_by_type = GraphLabelsByType::default();
    let mut input_address_refs = std::collections::HashMap::new();
    let mut output_address_refs = std::collections::HashMap::new();
    let mut address_occurrences = std::collections::HashMap::new();
    let label_store = state.labels.read().await;

    for (txid, node) in &graph.nodes {
        let txid_str = txid.to_string();
        let fee = enrich::compute_fee(node);
        let feerate = fee.map(|f| enrich::compute_feerate(f, node.vsize));
        let has_non_final = node.inputs.iter().any(|i| i.sequence < 0xFFFFFFFF);

        enrichments.insert(
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
                bitcoin::Address::from_script(output.script_pub_key.as_script(), state.network)
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

    for edge in &graph.edges {
        let Some(funding_node) = graph.nodes.get(&edge.funding_txid) else {
            continue;
        };
        let Some(funding_output) = funding_node.outputs.get(edge.funding_vout as usize) else {
            continue;
        };
        let Ok(address) =
            bitcoin::Address::from_script(funding_output.script_pub_key.as_script(), state.network)
        else {
            continue;
        };
        let input_ref = format!("{}:{}", edge.spending_txid, edge.input_index);
        input_address_refs.insert(input_ref, address.to_string());
    }

    Ok(Json(GraphResponse {
        graph,
        enrichments,
        labels_by_type,
        input_address_refs,
        output_address_refs,
        address_occurrences,
    }))
}

// -- Label files ---------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateLocalLabelFileRequest {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportLocalLabelFileRequest {
    name: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CreateOrImportLabelFileRequest {
    Create(CreateLocalLabelFileRequest),
    Import(ImportLocalLabelFileRequest),
}

async fn list_local_label_files(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Vec<LabelFileSummary>>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let store = state.labels.read().await;
    Ok(Json(
        store
            .list_files()
            .into_iter()
            .map(label_file_to_summary)
            .collect(),
    ))
}

async fn create_or_import_local_label_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    req: Result<Json<CreateOrImportLabelFileRequest>, JsonRejection>,
) -> Result<Json<LabelFileSummary>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let Json(req) = req.map_err(|e| AppError::BadRequest(e.to_string()))?;

    let mut store = state.labels.write().await;
    let created = match req {
        CreateOrImportLabelFileRequest::Create(request) => store.create_local_file(&request.name),
        CreateOrImportLabelFileRequest::Import(request) => {
            store.import_local_file(&request.name, &request.content)
        }
    }
    .map_err(map_label_store_error)?;

    let summary = store
        .get_local_file(&created)
        .map(label_file_to_summary)
        .ok_or_else(|| AppError::Internal("created local label file was not found".to_string()))?;

    Ok(Json(summary))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpsertLocalLabelRequest {
    #[serde(rename = "type")]
    label_type: Bip329Type,
    #[serde(rename = "ref")]
    ref_id: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplaceLocalLabelFileRequest {
    content: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum UpsertOrReplaceLabelFileRequest {
    Upsert(UpsertLocalLabelRequest),
    Replace(ReplaceLocalLabelFileRequest),
}

async fn upsert_or_replace_local_label_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
    req: Result<Json<UpsertOrReplaceLabelFileRequest>, JsonRejection>,
) -> Result<Json<LabelFileSummary>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let Json(req) = req.map_err(|e| AppError::BadRequest(e.to_string()))?;

    let mut store = state.labels.write().await;
    match req {
        UpsertOrReplaceLabelFileRequest::Upsert(request) => {
            store.set_local_label(&file_id, request.label_type, request.ref_id, request.label)
        }
        UpsertOrReplaceLabelFileRequest::Replace(request) => {
            store.replace_local_file_content(&file_id, &request.content)
        }
    }
    .map_err(map_label_store_error)?;

    let summary = store
        .get_local_file(&file_id)
        .map(label_file_to_summary)
        .ok_or_else(|| AppError::Internal("updated local label file was not found".to_string()))?;

    Ok(Json(summary))
}

async fn delete_local_label_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let mut store = state.labels.write().await;
    store
        .remove_local_file(&file_id)
        .map_err(map_label_store_error)?;

    Ok(Json(serde_json::json!({ "status": "deleted" })))
}

#[derive(Deserialize)]
struct DeleteLabelQuery {
    #[serde(rename = "type")]
    label_type: Bip329Type,
    #[serde(rename = "ref")]
    ref_id: String,
}

async fn delete_local_label_entry(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
    Query(query): Query<DeleteLabelQuery>,
) -> Result<Json<LabelFileSummary>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let mut store = state.labels.write().await;
    store
        .delete_local_label(&file_id, query.label_type, &query.ref_id)
        .map_err(map_label_store_error)?;

    let summary = store
        .get_local_file(&file_id)
        .map(label_file_to_summary)
        .ok_or_else(|| AppError::Internal("updated local label file was not found".to_string()))?;
    Ok(Json(summary))
}

async fn export_local_label_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Result<Response, AppError> {
    check_auth(&state.api_token, &headers)?;
    let store = state.labels.read().await;
    let file = store
        .get_local_file(&file_id)
        .ok_or_else(|| AppError::NotFound(format!("local label file not found: {file_id}")))?;
    let content = store
        .export_local_file(&file_id)
        .map_err(map_label_store_error)?;

    let mut response = (StatusCode::OK, content).into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    let disposition = format!("attachment; filename=\"{}.jsonl\"", file.name);
    let disposition_header = axum::http::HeaderValue::from_str(&disposition)
        .map_err(|e| AppError::Internal(format!("invalid content disposition header: {e}")))?;
    response
        .headers_mut()
        .insert(axum::http::header::CONTENT_DISPOSITION, disposition_header);
    Ok(response)
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
        return Err(AppError::Unauthorized(
            "invalid or missing X-API-Token".to_string(),
        ));
    }
    Ok(())
}

fn to_label_entries(
    labels: Vec<(&LabelFile, &cory_core::labels::Bip329Record)>,
) -> Vec<LabelEntry> {
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

fn label_file_to_summary(file: &LabelFile) -> LabelFileSummary {
    LabelFileSummary {
        id: file.id.clone(),
        name: file.name.clone(),
        kind: file.kind,
        editable: file.editable,
        record_count: file.record_count(),
    }
}
fn map_label_store_error(err: LabelStoreError) -> AppError {
    match err {
        LabelStoreError::DuplicateLocalFile(name) => {
            AppError::Conflict(format!("local label file already exists: {name}"))
        }
        LabelStoreError::LocalFileNotFound(file_id) => {
            AppError::NotFound(format!("local label file not found: {file_id}"))
        }
        LabelStoreError::EmptyFileName
        | LabelStoreError::EmptyRef
        | LabelStoreError::EmptyLabel => AppError::BadRequest(err.to_string()),
        LabelStoreError::Core(core) => AppError::BadRequest(core.to_string()),
    }
}

// ==============================================================================
// Error Type
// ==============================================================================

enum AppError {
    BadRequest(String),
    Unauthorized(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            Self::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg),
            Self::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            Self::Conflict(msg) => (StatusCode::CONFLICT, msg),
            Self::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}
