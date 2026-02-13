use std::collections::HashSet;
use std::env;

use reqwest::header::{HeaderMap, HeaderValue, ORIGIN};
use reqwest::Method;
use reqwest::{Client, StatusCode};
use serde_json::Value;

async fn wait_for_server(client: &Client, base_url: &str) {
    let health_url = format!("{base_url}/api/v1/health");
    for _ in 0..60 {
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status() == StatusCode::OK {
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    panic!("server did not become healthy in time");
}

/// Initialize authentication by calling /api/v1/auth/token.
/// This sets the JWT cookie in the client's cookie jar.
async fn init_auth(client: &Client, base_url: &str) {
    let token_url = format!("{base_url}/api/v1/auth/token");
    let resp = client
        .post(&token_url)
        .send()
        .await
        .expect("auth token request must succeed");
    assert_eq!(resp.status(), StatusCode::OK, "auth initialization failed");
}

fn assert_no_wildcard_cors(headers: &HeaderMap) {
    let allow_origin = headers
        .get("access-control-allow-origin")
        .and_then(|v| v.to_str().ok());
    assert_ne!(
        allow_origin,
        Some("*"),
        "CORS must not use wildcard access-control-allow-origin"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires local regtest bitcoind + cory process; run scripts/regtest/server_e2e.py"]
async fn regtest_server_endpoints_cover_api_surface() {
    let base_url =
        env::var("CORY_TEST_SERVER_BASE_URL").expect("CORY_TEST_SERVER_BASE_URL must be set");
    let valid_txid =
        env::var("CORY_TEST_SERVER_VALID_TXID").expect("CORY_TEST_SERVER_VALID_TXID must be set");

    // Create client with cookie jar for automatic cookie handling
    let client = Client::builder()
        .cookie_store(true) // Enable automatic cookie management
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest client must build");

    wait_for_server(&client, &base_url).await;

    // Initialize authentication - this sets the JWT cookie
    init_auth(&client, &base_url).await;

    // Health endpoint (no JWT required).
    let health_url = format!("{base_url}/api/v1/health");
    let health_resp = client
        .get(&health_url)
        .send()
        .await
        .expect("health request must succeed");
    assert_eq!(health_resp.status(), StatusCode::OK);
    let health_json: Value = health_resp
        .json()
        .await
        .expect("health response must be valid JSON");
    assert_eq!(health_json.get("status"), Some(&Value::String("ok".into())));

    // Create a client WITHOUT cookies for testing unauthorized access
    let no_cookie_client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("no-cookie client must build");

    // Graph endpoint requires auth - test without auth first
    let graph_url = format!("{base_url}/api/v1/graph/tx/{valid_txid}");
    let graph_no_auth = no_cookie_client
        .get(&graph_url)
        .send()
        .await
        .expect("graph request without auth should return response");
    assert_eq!(graph_no_auth.status(), StatusCode::UNAUTHORIZED);

    // Graph endpoint: valid txid payload shape (with auth).
    let graph_resp = client
        .get(&graph_url)
        .send()
        .await
        .expect("graph request with valid txid must succeed");
    assert_eq!(graph_resp.status(), StatusCode::OK);
    let graph_json: Value = graph_resp
        .json()
        .await
        .expect("graph response must be valid JSON");
    for key in [
        "nodes",
        "edges",
        "root_txid",
        "truncated",
        "stats",
        "enrichments",
        "labels",
    ] {
        assert!(
            graph_json.get(key).is_some(),
            "graph response must include top-level field `{key}`"
        );
    }

    // Graph endpoint: invalid txid returns client error (with auth).
    let invalid_graph_url = format!("{base_url}/api/v1/graph/tx/not-a-txid");
    let invalid_graph_resp = client
        .get(&invalid_graph_url)
        .send()
        .await
        .expect("graph request with invalid txid must return a response");
    assert_eq!(invalid_graph_resp.status(), StatusCode::BAD_REQUEST);
    let invalid_graph_json: Value = invalid_graph_resp
        .json()
        .await
        .expect("invalid graph error response must be JSON");
    let invalid_graph_error = invalid_graph_json
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(
        invalid_graph_error.contains("invalid txid"),
        "invalid txid error should mention invalid txid, got: {invalid_graph_error}"
    );

    // Labels auth checks for set endpoint.
    let set_url = format!("{base_url}/api/v1/labels/set");
    let set_payload = serde_json::json!({
        "type": "tx",
        "ref": &valid_txid,
        "label": "runner-set-label"
    });

    // Test missing auth using the client WITHOUT cookies
    let set_missing_auth = no_cookie_client
        .post(&set_url)
        .json(&set_payload)
        .send()
        .await
        .expect("set label without auth should return response");
    assert_eq!(set_missing_auth.status(), StatusCode::UNAUTHORIZED);

    // With valid cookie (already set via init_auth), the request succeeds
    let set_ok = client
        .post(&set_url)
        .json(&set_payload)
        .send()
        .await
        .expect("set label with valid auth should succeed");
    assert_eq!(set_ok.status(), StatusCode::OK);
    let set_ok_json: Value = set_ok
        .json()
        .await
        .expect("set label success response must be JSON");
    assert_eq!(set_ok_json.get("status"), Some(&Value::String("ok".into())));

    // Set label malformed payloads return client errors.
    let set_bad_json = client
        .post(&set_url)
        .header("Content-Type", "application/json")
        .body("{\"type\":\"tx\",\"ref\":\"abc\",\"label\":}")
        .send()
        .await
        .expect("set label malformed JSON should return a response");
    assert_eq!(set_bad_json.status(), StatusCode::BAD_REQUEST);

    let set_invalid_type = client
        .post(&set_url)
        .json(&serde_json::json!({
            "type": "not-a-valid-type",
            "ref": valid_txid,
            "label": "x"
        }))
        .send()
        .await
        .expect("set label invalid type should return a response");
    assert_eq!(set_invalid_type.status(), StatusCode::BAD_REQUEST);

    // Label import/export flow.
    let import_url = format!("{base_url}/api/v1/labels/import");
    let import_valid_body = format!(
        "{}\n{}",
        serde_json::json!({"type":"tx","ref":&valid_txid,"label":"runner-import-label"}),
        serde_json::json!({"type":"addr","ref":"bcrt1qexampleimport0000000000000000000000000","label":"runner-addr-label"})
    );

    // Test missing auth using the client WITHOUT cookies
    let import_missing_auth = no_cookie_client
        .post(&import_url)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(import_valid_body.clone())
        .send()
        .await
        .expect("import without auth should return response");
    assert_eq!(import_missing_auth.status(), StatusCode::UNAUTHORIZED);

    // With valid cookie (from init_auth), import succeeds
    let import_ok = client
        .post(&import_url)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(import_valid_body)
        .send()
        .await
        .expect("import with valid auth should succeed");
    assert_eq!(import_ok.status(), StatusCode::OK);
    let import_ok_json: Value = import_ok
        .json()
        .await
        .expect("import success response must be JSON");
    assert_eq!(
        import_ok_json.get("status"),
        Some(&Value::String("imported".into()))
    );

    let malformed_import = client
        .post(&import_url)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body("{\"type\":\"tx\",\"ref\":\"x\",\"label\":}\n")
        .send()
        .await
        .expect("malformed import should return response");
    assert_eq!(malformed_import.status(), StatusCode::BAD_REQUEST);
    let malformed_json: Value = malformed_import
        .json()
        .await
        .expect("malformed import error response must be JSON");
    let malformed_error = malformed_json
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(
        malformed_error.contains("label parse error"),
        "malformed import error should mention label parse error, got: {malformed_error}"
    );

    let export_url = format!("{base_url}/api/v1/labels/export");

    // Test export without auth
    let export_no_auth = no_cookie_client
        .get(&export_url)
        .send()
        .await
        .expect("export without auth should return response");
    assert_eq!(export_no_auth.status(), StatusCode::UNAUTHORIZED);

    // Test export with valid auth
    let export_resp = client
        .get(&export_url)
        .send()
        .await
        .expect("export labels request must succeed");
    assert_eq!(export_resp.status(), StatusCode::OK);
    let export_headers = export_resp.headers().clone();
    let export_content_type = export_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(export_content_type, "text/plain; charset=utf-8");
    let export_body = export_resp
        .text()
        .await
        .expect("export response body must be readable");

    let mut seen = HashSet::new();
    for line in export_body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(line).expect("exported JSONL line must parse");
        let label_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let ref_id = row
            .get("ref")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let label = row
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        seen.insert((label_type, ref_id, label));
    }

    assert!(
        seen.contains(&(
            "tx".to_string(),
            valid_txid.clone(),
            "runner-import-label".to_string()
        )),
        "export must include imported tx label"
    );
    assert!(
        seen.contains(&(
            "addr".to_string(),
            "bcrt1qexampleimport0000000000000000000000000".to_string(),
            "runner-addr-label".to_string()
        )),
        "export must include imported addr label"
    );

    // Fallback static UI endpoint.
    let root_resp = client
        .get(format!("{base_url}/"))
        .send()
        .await
        .expect("root static UI request must succeed");
    assert_eq!(root_resp.status(), StatusCode::OK);
    let root_content_type = root_resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        root_content_type.starts_with("text/html"),
        "root fallback must serve HTML content-type"
    );
    let root_body = root_resp
        .text()
        .await
        .expect("root fallback body must be readable");
    assert!(
        root_body.contains("<title>Cory") || root_body.contains("id=\"txid-input\""),
        "root fallback should include embedded UI HTML markers"
    );

    let deep_fallback_resp = client
        .get(format!("{base_url}/some/client/route"))
        .send()
        .await
        .expect("deep fallback request must succeed");
    assert_eq!(deep_fallback_resp.status(), StatusCode::OK);

    // CORS behavior checks: exact allowed origin, no wildcard, disallowed origin omitted.
    let allowed_origin = base_url.clone();
    let allowed_resp = client
        .get(&health_url)
        .header(
            ORIGIN,
            HeaderValue::from_str(&allowed_origin).expect("allowed origin must parse"),
        )
        .send()
        .await
        .expect("allowed-origin CORS request must return response");
    assert_eq!(allowed_resp.status(), StatusCode::OK);
    let allowed_headers = allowed_resp.headers();
    assert_no_wildcard_cors(allowed_headers);
    let allowed_cors = allowed_headers
        .get("access-control-allow-origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(allowed_cors, allowed_origin);

    let disallowed_origin = "http://evil.local";
    let disallowed_resp = client
        .get(&health_url)
        .header(ORIGIN, HeaderValue::from_static(disallowed_origin))
        .send()
        .await
        .expect("disallowed-origin CORS request must return response");
    let disallowed_headers = disallowed_resp.headers();
    assert_no_wildcard_cors(disallowed_headers);
    let disallowed_cors = disallowed_headers
        .get("access-control-allow-origin")
        .and_then(|v| v.to_str().ok());
    assert!(
        disallowed_cors != Some(disallowed_origin),
        "disallowed origin must not be granted via matching access-control-allow-origin"
    );
    assert_eq!(
        disallowed_cors,
        Some(allowed_origin.as_str()),
        "server should keep returning only the configured exact origin"
    );

    // CORS preflight checks.
    let preflight_allowed = client
        .request(Method::OPTIONS, &set_url)
        .header(
            ORIGIN,
            HeaderValue::from_str(&allowed_origin).expect("allowed origin must parse"),
        )
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "content-type")
        .send()
        .await
        .expect("allowed preflight request must return response");
    assert_eq!(preflight_allowed.status(), StatusCode::OK);
    let preflight_allowed_headers = preflight_allowed.headers();
    assert_no_wildcard_cors(preflight_allowed_headers);
    let preflight_allowed_origin = preflight_allowed_headers
        .get("access-control-allow-origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(preflight_allowed_origin, allowed_origin);
    let preflight_allow_methods = preflight_allowed_headers
        .get("access-control-allow-methods")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_uppercase();
    assert!(
        preflight_allow_methods.contains("POST"),
        "preflight allow-methods should include POST"
    );
    let preflight_allow_headers = preflight_allowed_headers
        .get("access-control-allow-headers")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        preflight_allow_headers.contains("content-type"),
        "preflight allow-headers should include content-type"
    );
    // Note: Cookies are handled automatically by browser, not via CORS headers

    let preflight_disallowed = client
        .request(Method::OPTIONS, &set_url)
        .header(ORIGIN, HeaderValue::from_static(disallowed_origin))
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "content-type")
        .send()
        .await
        .expect("disallowed preflight request must return response");
    let preflight_disallowed_headers = preflight_disallowed.headers();
    assert_no_wildcard_cors(preflight_disallowed_headers);
    let preflight_disallowed_origin = preflight_disallowed_headers
        .get("access-control-allow-origin")
        .and_then(|v| v.to_str().ok());
    assert!(
        preflight_disallowed_origin != Some(disallowed_origin),
        "disallowed preflight origin must not be granted"
    );
}
