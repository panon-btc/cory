use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use cory_core::labels::LabelStoreError;

// ==============================================================================
// Error Type
// ==============================================================================

pub(crate) enum AppError {
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

pub(super) fn map_label_store_error(err: LabelStoreError) -> AppError {
    match err {
        LabelStoreError::DuplicateFileId(name) => {
            AppError::Conflict(format!("label file already exists: {name}"))
        }
        LabelStoreError::FileNotFound(file_id) => {
            AppError::NotFound(format!("label file not found: {file_id}"))
        }
        LabelStoreError::ReadOnlyFile(_) | LabelStoreError::NotBrowserFile(_) => {
            AppError::BadRequest(err.to_string())
        }
        LabelStoreError::EmptyFileName
        | LabelStoreError::EmptyRef
        | LabelStoreError::EmptyLabel => AppError::BadRequest(err.to_string()),
        LabelStoreError::Core(core) => AppError::BadRequest(core.to_string()),
    }
}
