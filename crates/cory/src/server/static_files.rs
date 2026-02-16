use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

// ==============================================================================
// Static File Serving
// ==============================================================================

#[derive(Embed)]
#[folder = "ui/dist/"]
struct Assets;

/// Serves the embedded SPA. Exact file matches are returned with the correct
/// MIME type; everything else falls back to `index.html` for client-side routing.
pub(super) async fn static_files(uri: axum::http::Uri) -> Response {
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
