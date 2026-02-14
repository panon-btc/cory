use std::collections::HashSet;
use std::env;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, ORIGIN};
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

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct AuthTokenResponse {
    session_id: String,
    access_token: String,
    access_token_expires_in: u64,
    refresh_token_expires_in: u64,
    message: String,
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct RefreshTokenResponse {
    access_token: String,
    access_token_expires_in: u64,
    message: String,
}

/// Acquires auth tokens. Returns the access token which should be used in
async fn init_auth(client: &Client, base_url: &str) -> String {
    let token_url = format!("{base_url}/api/v1/auth/token");
    let resp = client
        .post(&token_url)
        .send()
        .await
        .expect("auth token request must succeed");
    assert_eq!(resp.status(), StatusCode::OK, "auth initialization failed");

    let auth_response: AuthTokenResponse = resp
        .json()
        .await
        .expect("auth token response must be valid JSON");

    // Verify response structure
    assert!(
        !auth_response.access_token.is_empty(),
        "access_token must be present in response"
    );
    assert!(
        !auth_response.session_id.is_empty(),
        "session_id must be present in response"
    );
    assert_eq!(
        auth_response.access_token_expires_in,
        15 * 60,
        "access_token should expire in 15 minutes"
    );
    assert_eq!(
        auth_response.refresh_token_expires_in,
        7 * 24 * 60 * 60,
        "refresh_token should expire in 7 days"
    );

    auth_response.access_token
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

    // Client with cookie store for refresh token handling
    let client = Client::builder()
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest client must build");
    // Client without cookie store to test unauthorized access
    let no_cookie_client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("no-cookie client must build");

    wait_for_server(&client, &base_url).await;

    // Acquire access token (refresh token is stored in httpOnly cookie)
    let access_token = init_auth(&client, &base_url).await;
    let auth_header_value = format!("Bearer {access_token}");

    // Health endpoint (public, no auth required).
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

    // Graph endpoint: valid txid payload shape.
    let graph_url = format!("{base_url}/api/v1/graph/tx/{valid_txid}");

    // Request without auth should fail
    let graph_no_auth = no_cookie_client
        .get(&graph_url)
        .send()
        .await
        .expect("graph request without auth should return response");
    assert_eq!(graph_no_auth.status(), StatusCode::UNAUTHORIZED);

    // Request with access token in Authorization header should succeed
    let graph_resp = client
        .get(&graph_url)
        .header(AUTHORIZATION, &auth_header_value)
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
        "labels_by_type",
        "input_address_refs",
        "output_address_refs",
        "address_occurrences",
    ] {
        assert!(
            graph_json.get(key).is_some(),
            "graph response must include top-level field `{key}`"
        );
    }

    // Graph endpoint: invalid txid returns client error.
    let invalid_graph_url = format!("{base_url}/api/v1/graph/tx/not-a-txid");
    let invalid_graph_resp = client
        .get(&invalid_graph_url)
        .header(AUTHORIZATION, &auth_header_value)
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

    let label_url = format!("{base_url}/api/v1/label");

    // Local file create auth checks.
    let create_payload = serde_json::json!({ "name": "runner-file" });
    let create_missing_auth = no_cookie_client
        .post(&label_url)
        .json(&create_payload)
        .send()
        .await
        .expect("create label file without auth should return response");
    assert_eq!(create_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let create_ok = client
        .post(&label_url)
        .header(AUTHORIZATION, &auth_header_value)
        .json(&create_payload)
        .send()
        .await
        .expect("create label file with valid auth should succeed");
    assert_eq!(create_ok.status(), StatusCode::OK);
    let create_ok_json: Value = create_ok
        .json()
        .await
        .expect("create label file response must be JSON");
    let file_id = create_ok_json
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    assert!(
        !file_id.is_empty(),
        "create response should include file id"
    );

    let duplicate_create = client
        .post(&label_url)
        .header(AUTHORIZATION, &auth_header_value)
        .json(&create_payload)
        .send()
        .await
        .expect("duplicate create should return response");
    assert_eq!(duplicate_create.status(), StatusCode::CONFLICT);

    // Import as new file.
    let import_payload = serde_json::json!({
        "name": "runner-import-file",
        "content": format!(
            "{}\n{}",
            serde_json::json!({"type":"tx","ref":&valid_txid,"label":"runner-import-label"}),
            serde_json::json!({"type":"addr","ref":"bcrt1qexampleimport0000000000000000000000000","label":"runner-addr-label"})
        )
    });

    let import_missing_auth = no_cookie_client
        .post(&label_url)
        .json(&import_payload)
        .send()
        .await
        .expect("import without auth should return response");
    assert_eq!(import_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let import_ok = client
        .post(&label_url)
        .header(AUTHORIZATION, &auth_header_value)
        .json(&import_payload)
        .send()
        .await
        .expect("import with valid auth should succeed");
    assert_eq!(import_ok.status(), StatusCode::OK);
    let import_ok_json: Value = import_ok
        .json()
        .await
        .expect("import response must be JSON");
    let import_file_id = import_ok_json
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    assert!(
        !import_file_id.is_empty(),
        "import response should include file id"
    );

    // Upsert label in created file.
    let upsert_url = format!("{base_url}/api/v1/label/{file_id}");
    let upsert_payload = serde_json::json!({
        "type": "tx",
        "ref": &valid_txid,
        "label": "runner-set-label"
    });

    let upsert_missing_auth = no_cookie_client
        .post(&upsert_url)
        .json(&upsert_payload)
        .send()
        .await
        .expect("upsert without auth should return response");
    assert_eq!(upsert_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let upsert_ok = client
        .post(&upsert_url)
        .header(AUTHORIZATION, &auth_header_value)
        .json(&upsert_payload)
        .send()
        .await
        .expect("upsert with valid auth should succeed");
    assert_eq!(upsert_ok.status(), StatusCode::OK);

    let upsert_bad_json = client
        .post(&upsert_url)
        .header(AUTHORIZATION, &auth_header_value)
        .header("Content-Type", "application/json")
        .body("{\"type\":\"tx\",\"ref\":\"abc\",\"label\":}")
        .send()
        .await
        .expect("upsert malformed JSON should return a response");
    assert_eq!(upsert_bad_json.status(), StatusCode::BAD_REQUEST);

    let upsert_invalid_type = client
        .post(&upsert_url)
        .header(AUTHORIZATION, &auth_header_value)
        .json(&serde_json::json!({
            "type": "not-a-valid-type",
            "ref": valid_txid,
            "label": "x"
        }))
        .send()
        .await
        .expect("upsert invalid type should return a response");
    assert_eq!(upsert_invalid_type.status(), StatusCode::BAD_REQUEST);

    // Replace content for created file.
    let replace_ok = client
        .post(&upsert_url)
        .header(AUTHORIZATION, &auth_header_value)
        .json(&serde_json::json!({
            "content": serde_json::json!({"type":"tx","ref":&valid_txid,"label":"runner-replaced"}).to_string()
        }))
        .send()
        .await
        .expect("replace content should return response");
    assert_eq!(replace_ok.status(), StatusCode::OK);

    let replace_malformed = client
        .post(&upsert_url)
        .header(AUTHORIZATION, &auth_header_value)
        .json(&serde_json::json!({
            "content": "{\"type\":\"tx\",\"ref\":\"x\",\"label\":}\n"
        }))
        .send()
        .await
        .expect("malformed replace should return response");
    assert_eq!(replace_malformed.status(), StatusCode::BAD_REQUEST);

    // List files should include both created files.
    let list_resp = client
        .get(&label_url)
        .header(AUTHORIZATION, &auth_header_value)
        .send()
        .await
        .expect("list label files should return response");
    assert_eq!(list_resp.status(), StatusCode::OK);
    let listed_files: Value = list_resp
        .json()
        .await
        .expect("list label files response must be JSON");
    let listed_ids: HashSet<String> = listed_files
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert!(
        listed_ids.contains(&file_id),
        "list should include created file"
    );
    assert!(
        listed_ids.contains(&import_file_id),
        "list should include imported file"
    );

    // Export imported file.
    let export_url = format!("{base_url}/api/v1/label/{import_file_id}/export");
    let export_resp = client
        .get(&export_url)
        .header(AUTHORIZATION, &auth_header_value)
        .send()
        .await
        .expect("export label file request must succeed");
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
        "export should include imported tx label"
    );
    assert!(
        seen.contains(&(
            "addr".to_string(),
            "bcrt1qexampleimport0000000000000000000000000".to_string(),
            "runner-addr-label".to_string()
        )),
        "export should include imported addr label"
    );

    // Delete imported file.
    let delete_missing_auth = no_cookie_client
        .delete(format!("{base_url}/api/v1/label/{import_file_id}"))
        .send()
        .await
        .expect("delete without auth should return response");
    assert_eq!(delete_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let delete_ok = client
        .delete(format!("{base_url}/api/v1/label/{import_file_id}"))
        .header(AUTHORIZATION, &auth_header_value)
        .send()
        .await
        .expect("delete with auth should return response");
    assert_eq!(delete_ok.status(), StatusCode::OK);

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
        disallowed_cors, None,
        "server should omit access-control-allow-origin for disallowed origins"
    );

    // CORS preflight checks.
    let preflight_allowed = client
        .request(Method::OPTIONS, &label_url)
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

    let preflight_disallowed = client
        .request(Method::OPTIONS, &label_url)
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

    //Basic flow followed
    // 1. Login returns access token in body, refresh token in httpOnly cookie
    // 2. Access token is used in Authorization header for API calls
    // 3. Refresh endpoint uses cookie to issue new access token
    // 4. Logout clears the refresh token cookie

    // Test that refresh endpoint returns new access token using the refresh
    // token that was set in cookie during init_auth above.
    let refresh_url = format!("{base_url}/api/v1/auth/refresh");
    let refresh_resp = client
        .post(&refresh_url)
        .send()
        .await
        .expect("refresh token request must succeed");
    assert_eq!(refresh_resp.status(), StatusCode::OK);

    let refresh_json: RefreshTokenResponse = refresh_resp
        .json()
        .await
        .expect("refresh response must be valid JSON");
    assert!(
        !refresh_json.access_token.is_empty(),
        "refresh should return new access_token"
    );
    assert_eq!(
        refresh_json.access_token_expires_in,
        15 * 60,
        "new access_token should expire in 15 minutes"
    );

    // Verify the new access token works for API calls
    let new_auth_header = format!("Bearer {}", refresh_json.access_token);
    let graph_with_new_token = client
        .get(&graph_url)
        .header(AUTHORIZATION, &new_auth_header)
        .send()
        .await
        .expect("graph request with refreshed token should succeed");
    assert_eq!(graph_with_new_token.status(), StatusCode::OK);

    // Test that refresh fails without the cookie (using no_cookie_client)
    let refresh_no_cookie = no_cookie_client
        .post(&refresh_url)
        .send()
        .await
        .expect("refresh without cookie should return response");
    assert_eq!(
        refresh_no_cookie.status(),
        StatusCode::UNAUTHORIZED,
        "refresh without cookie should fail"
    );

    // Test logout clears the session
    let logout_url = format!("{base_url}/api/v1/auth/logout");
    let logout_resp = client
        .post(&logout_url)
        .send()
        .await
        .expect("logout request must succeed");
    assert_eq!(logout_resp.status(), StatusCode::OK);
    let logout_json: Value = logout_resp
        .json()
        .await
        .expect("logout response must be valid JSON");
    assert_eq!(
        logout_json.get("message").and_then(Value::as_str),
        Some("Logged out successfully")
    );

    // After logout, refresh should fail (cookie was cleared)
    let refresh_after_logout = client
        .post(&refresh_url)
        .send()
        .await
        .expect("refresh after logout should return response");
    assert_eq!(
        refresh_after_logout.status(),
        StatusCode::UNAUTHORIZED,
        "refresh after logout should fail because cookie was cleared"
    );
}
