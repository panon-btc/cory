use axum::http::HeaderMap;

use super::error::AppError;

pub(super) fn check_auth(expected_token: &str, headers: &HeaderMap) -> Result<(), AppError> {
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
