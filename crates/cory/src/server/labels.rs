use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use cory_core::labels::{Bip329Type, LabelFile, LabelFileKind};

use super::auth::check_auth;
use super::error::{map_label_store_error, AppError};
use super::SharedState;

// ==============================================================================
// DTOs
// ==============================================================================

#[derive(Serialize)]
pub(super) struct LabelFileSummary {
    id: String,
    name: String,
    kind: LabelFileKind,
    editable: bool,
    record_count: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateBrowserLabelFileRequest {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportBrowserLabelFileRequest {
    name: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum CreateOrImportLabelFileRequest {
    Create(CreateBrowserLabelFileRequest),
    Import(ImportBrowserLabelFileRequest),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpsertLabelRequest {
    #[serde(rename = "type")]
    label_type: Bip329Type,
    #[serde(rename = "ref")]
    ref_id: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReplaceBrowserLabelFileRequest {
    content: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum UpsertOrReplaceLabelFileRequest {
    Upsert(UpsertLabelRequest),
    Replace(ReplaceBrowserLabelFileRequest),
}

#[derive(Deserialize)]
pub(super) struct DeleteLabelQuery {
    #[serde(rename = "type")]
    label_type: Bip329Type,
    #[serde(rename = "ref")]
    ref_id: String,
}

// ==============================================================================
// Handlers
// ==============================================================================

pub(super) async fn list_local_label_files(
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

pub(super) async fn create_or_import_local_label_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    req: Result<Json<CreateOrImportLabelFileRequest>, JsonRejection>,
) -> Result<Json<LabelFileSummary>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let Json(req) = req.map_err(|e| AppError::BadRequest(e.to_string()))?;

    let mut store = state.labels.write().await;
    let created = match req {
        CreateOrImportLabelFileRequest::Create(request) => store.create_browser_file(&request.name),
        CreateOrImportLabelFileRequest::Import(request) => {
            store.import_browser_file(&request.name, &request.content)
        }
    }
    .map_err(map_label_store_error)?;

    let summary = store
        .get_file(&created)
        .map(label_file_to_summary)
        .ok_or_else(|| AppError::Internal("created label file was not found".to_string()))?;

    Ok(Json(summary))
}

pub(super) async fn upsert_or_replace_local_label_file(
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
            store.set_label(&file_id, request.label_type, request.ref_id, request.label)
        }
        UpsertOrReplaceLabelFileRequest::Replace(request) => {
            store.replace_browser_file_content(&file_id, &request.content)
        }
    }
    .map_err(map_label_store_error)?;

    let summary = store
        .get_file(&file_id)
        .map(label_file_to_summary)
        .ok_or_else(|| AppError::Internal("updated label file was not found".to_string()))?;

    Ok(Json(summary))
}

pub(super) async fn delete_local_label_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let mut store = state.labels.write().await;
    store
        .remove_browser_file(&file_id)
        .map_err(map_label_store_error)?;

    Ok(Json(serde_json::json!({ "status": "deleted" })))
}

pub(super) async fn delete_local_label_entry(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
    Query(query): Query<DeleteLabelQuery>,
) -> Result<Json<LabelFileSummary>, AppError> {
    check_auth(&state.api_token, &headers)?;
    let mut store = state.labels.write().await;
    store
        .delete_label(&file_id, query.label_type, &query.ref_id)
        .map_err(map_label_store_error)?;

    let summary = store
        .get_file(&file_id)
        .map(label_file_to_summary)
        .ok_or_else(|| AppError::Internal("updated label file was not found".to_string()))?;
    Ok(Json(summary))
}

pub(super) async fn export_local_label_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Result<Response, AppError> {
    check_auth(&state.api_token, &headers)?;
    let store = state.labels.read().await;
    let file = store
        .get_file(&file_id)
        .ok_or_else(|| AppError::NotFound(format!("label file not found: {file_id}")))?;
    let content = store.export_file(&file_id).map_err(map_label_store_error)?;

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
// Helpers
// ==============================================================================

pub(super) fn label_file_to_summary(file: &LabelFile) -> LabelFileSummary {
    LabelFileSummary {
        id: file.id.clone(),
        name: file.name.clone(),
        kind: file.kind,
        editable: file.editable,
        record_count: file.record_count(),
    }
}
