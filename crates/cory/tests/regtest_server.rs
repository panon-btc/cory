use std::collections::HashSet;
use std::env;
use std::io::{Cursor, Read};

use reqwest::header::{HeaderMap, HeaderValue, ORIGIN};
use reqwest::Method;
use reqwest::{Client, StatusCode};
use serde_json::Value;
use zip::ZipArchive;

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
    let api_token =
        env::var("CORY_TEST_SERVER_API_TOKEN").expect("CORY_TEST_SERVER_API_TOKEN must be set");
    let valid_txid =
        env::var("CORY_TEST_SERVER_VALID_TXID").expect("CORY_TEST_SERVER_VALID_TXID must be set");

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest client must build");
    let unauthed_client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("unauthed client must build");

    wait_for_server(&client, &base_url).await;

    // =========================================================================
    // Health (public, no auth required)
    // =========================================================================

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

    // =========================================================================
    // Graph
    // =========================================================================

    let graph_url = format!("{base_url}/api/v1/graph/tx/{valid_txid}");
    let history_url = format!("{base_url}/api/v1/history");

    let history_no_auth = unauthed_client
        .get(&history_url)
        .send()
        .await
        .expect("history request without auth should return response");
    assert_eq!(history_no_auth.status(), StatusCode::UNAUTHORIZED);

    let history_before_graph = client
        .get(&history_url)
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("history request before graph search should return response");
    assert_eq!(history_before_graph.status(), StatusCode::OK);
    let history_before_graph_json: Value = history_before_graph
        .json()
        .await
        .expect("history response before graph search must be JSON");
    assert_eq!(
        history_before_graph_json
            .get("entries")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(0),
        "history should be empty before any graph search"
    );

    // Request without auth should fail.
    let graph_no_auth = unauthed_client
        .get(&graph_url)
        .send()
        .await
        .expect("graph request without auth should return response");
    assert_eq!(graph_no_auth.status(), StatusCode::UNAUTHORIZED);

    // Request with API token should succeed and include all expected fields.
    let graph_resp = client
        .get(&graph_url)
        .header("X-API-Token", &api_token)
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

    let history_after_graph = client
        .get(&history_url)
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("history request after first graph search should return response");
    assert_eq!(history_after_graph.status(), StatusCode::OK);
    let history_after_graph_json: Value = history_after_graph
        .json()
        .await
        .expect("history response after first graph search must be JSON");
    let history_after_graph_entries = history_after_graph_json
        .get("entries")
        .and_then(Value::as_array)
        .expect("history entries should be an array after first search");
    assert_eq!(
        history_after_graph_entries.len(),
        1,
        "history should contain one txid after first search"
    );
    assert_eq!(
        history_after_graph_entries[0]
            .get("txid")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        valid_txid,
        "history entry should record searched txid"
    );
    let first_search_timestamp = history_after_graph_entries[0]
        .get("searched_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    assert!(
        first_search_timestamp.contains('T') && first_search_timestamp.ends_with('Z'),
        "history timestamp should be RFC3339 UTC-like, got: {first_search_timestamp}"
    );

    tokio::time::sleep(std::time::Duration::from_millis(25)).await;

    let repeated_graph_resp = client
        .get(&graph_url)
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("repeated graph request must succeed");
    assert_eq!(repeated_graph_resp.status(), StatusCode::OK);

    let history_after_repeat = client
        .get(&history_url)
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("history request after repeated graph search should return response");
    assert_eq!(history_after_repeat.status(), StatusCode::OK);
    let history_after_repeat_json: Value = history_after_repeat
        .json()
        .await
        .expect("history response after repeated graph search must be JSON");
    let history_after_repeat_entries = history_after_repeat_json
        .get("entries")
        .and_then(Value::as_array)
        .expect("history entries should be an array after repeated search");
    assert_eq!(
        history_after_repeat_entries.len(),
        1,
        "history should deduplicate repeated txid searches"
    );
    let repeated_search_timestamp = history_after_repeat_entries[0]
        .get("searched_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    assert_ne!(
        repeated_search_timestamp, first_search_timestamp,
        "repeated search should update existing txid timestamp"
    );

    // Invalid txid returns client error.
    let invalid_graph_url = format!("{base_url}/api/v1/graph/tx/not-a-txid");
    let invalid_graph_resp = client
        .get(&invalid_graph_url)
        .header("X-API-Token", &api_token)
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

    // =========================================================================
    // Labels — create
    // =========================================================================

    let label_url = format!("{base_url}/api/v1/label");
    let export_all_url = format!("{base_url}/api/v1/labels.zip");

    let export_all_missing_auth = unauthed_client
        .get(&export_all_url)
        .send()
        .await
        .expect("export-all without auth should return response");
    assert_eq!(export_all_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let export_all_before_create = client
        .get(&export_all_url)
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("export-all before create should return response");
    assert_eq!(export_all_before_create.status(), StatusCode::NOT_FOUND);
    let export_all_before_create_json: Value = export_all_before_create
        .json()
        .await
        .expect("export-all not-found response must be JSON");
    assert_eq!(
        export_all_before_create_json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "no browser label files to export"
    );

    let create_payload = serde_json::json!({ "name": "runner-file" });
    let create_missing_auth = unauthed_client
        .post(&label_url)
        .json(&create_payload)
        .send()
        .await
        .expect("create label file without auth should return response");
    assert_eq!(create_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let create_ok = client
        .post(&label_url)
        .header("X-API-Token", &api_token)
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
        .header("X-API-Token", &api_token)
        .json(&create_payload)
        .send()
        .await
        .expect("duplicate create should return response");
    assert_eq!(duplicate_create.status(), StatusCode::CONFLICT);

    // =========================================================================
    // Labels — import
    // =========================================================================

    let import_payload = serde_json::json!({
        "name": "runner-import-file",
        "content": format!(
            "{}\n{}",
            serde_json::json!({"type":"tx","ref":&valid_txid,"label":"runner-import-label"}),
            serde_json::json!({"type":"addr","ref":"bcrt1qexampleimport0000000000000000000000000","label":"runner-addr-label"})
        )
    });

    let import_missing_auth = unauthed_client
        .post(&label_url)
        .json(&import_payload)
        .send()
        .await
        .expect("import without auth should return response");
    assert_eq!(import_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let import_ok = client
        .post(&label_url)
        .header("X-API-Token", &api_token)
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

    // =========================================================================
    // Labels — upsert and replace
    // =========================================================================

    let upsert_url = format!("{base_url}/api/v1/label/{file_id}");
    let upsert_payload = serde_json::json!({
        "type": "tx",
        "ref": &valid_txid,
        "label": "runner-set-label"
    });

    let upsert_missing_auth = unauthed_client
        .post(&upsert_url)
        .json(&upsert_payload)
        .send()
        .await
        .expect("upsert without auth should return response");
    assert_eq!(upsert_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let upsert_ok = client
        .post(&upsert_url)
        .header("X-API-Token", &api_token)
        .json(&upsert_payload)
        .send()
        .await
        .expect("upsert with valid auth should succeed");
    assert_eq!(upsert_ok.status(), StatusCode::OK);

    let upsert_bad_json = client
        .post(&upsert_url)
        .header("X-API-Token", &api_token)
        .header("Content-Type", "application/json")
        .body("{\"type\":\"tx\",\"ref\":\"abc\",\"label\":}")
        .send()
        .await
        .expect("upsert malformed JSON should return a response");
    assert_eq!(upsert_bad_json.status(), StatusCode::BAD_REQUEST);

    let upsert_invalid_type = client
        .post(&upsert_url)
        .header("X-API-Token", &api_token)
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
        .header("X-API-Token", &api_token)
        .json(&serde_json::json!({
            "content": serde_json::json!({"type":"tx","ref":&valid_txid,"label":"runner-replaced"}).to_string()
        }))
        .send()
        .await
        .expect("replace content should return response");
    assert_eq!(replace_ok.status(), StatusCode::OK);

    let replace_malformed = client
        .post(&upsert_url)
        .header("X-API-Token", &api_token)
        .json(&serde_json::json!({
            "content": "{\"type\":\"tx\",\"ref\":\"x\",\"label\":}\n"
        }))
        .send()
        .await
        .expect("malformed replace should return response");
    assert_eq!(replace_malformed.status(), StatusCode::BAD_REQUEST);

    // =========================================================================
    // Labels — list
    // =========================================================================

    let list_resp = client
        .get(&label_url)
        .header("X-API-Token", &api_token)
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

    // =========================================================================
    // Labels — export
    // =========================================================================

    let export_url = format!("{base_url}/api/v1/label/{import_file_id}/export");
    let export_resp = client
        .get(&export_url)
        .header("X-API-Token", &api_token)
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

    // =========================================================================
    // Labels — export all browser files as zip
    // =========================================================================

    let export_all_ok = client
        .get(&export_all_url)
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("export-all browser labels request must succeed");
    assert_eq!(export_all_ok.status(), StatusCode::OK);
    let export_all_headers = export_all_ok.headers().clone();
    let export_all_content_type = export_all_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(export_all_content_type, "application/zip");
    let export_all_disposition = export_all_headers
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        export_all_disposition,
        "attachment; filename=\"labels.zip\""
    );

    let zip_body = export_all_ok
        .bytes()
        .await
        .expect("zip response body must be readable");
    let mut archive = ZipArchive::new(Cursor::new(zip_body))
        .expect("export-all response body must be a readable zip archive");
    let names: HashSet<String> = archive.file_names().map(str::to_string).collect();
    assert!(
        names.contains("labels/runner-file.jsonl"),
        "zip should include created browser file"
    );
    assert!(
        names.contains("labels/runner-import-file.jsonl"),
        "zip should include imported browser file"
    );

    let mut imported_file = archive
        .by_name("labels/runner-import-file.jsonl")
        .expect("imported file should be present in zip");
    let mut imported_content = String::new();
    imported_file
        .read_to_string(&mut imported_content)
        .expect("zip entry payload should be readable utf-8");
    assert!(
        imported_content.contains("runner-import-label"),
        "zip export should include imported tx label"
    );
    assert!(
        imported_content.contains("runner-addr-label"),
        "zip export should include imported addr label"
    );

    // =========================================================================
    // Labels — delete entry and delete file
    // =========================================================================

    // Delete a single label entry from the imported file.
    let delete_entry_url =
        format!("{base_url}/api/v1/label/{import_file_id}/entry?type=tx&ref={valid_txid}");
    let delete_entry_missing_auth = unauthed_client
        .delete(&delete_entry_url)
        .send()
        .await
        .expect("delete entry without auth should return response");
    assert_eq!(delete_entry_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let delete_entry_ok = client
        .delete(&delete_entry_url)
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("delete entry with auth should succeed");
    assert_eq!(delete_entry_ok.status(), StatusCode::OK);
    let delete_entry_json: Value = delete_entry_ok
        .json()
        .await
        .expect("delete entry response must be JSON");
    // After deleting one of two records, the file should have one record left.
    assert_eq!(
        delete_entry_json.get("record_count"),
        Some(&Value::Number(1.into())),
        "imported file should have one record after deleting a label entry"
    );

    // Delete imported file.
    let delete_missing_auth = unauthed_client
        .delete(format!("{base_url}/api/v1/label/{import_file_id}"))
        .send()
        .await
        .expect("delete without auth should return response");
    assert_eq!(delete_missing_auth.status(), StatusCode::UNAUTHORIZED);

    let delete_ok = client
        .delete(format!("{base_url}/api/v1/label/{import_file_id}"))
        .header("X-API-Token", &api_token)
        .send()
        .await
        .expect("delete with auth should return response");
    assert_eq!(delete_ok.status(), StatusCode::OK);

    // =========================================================================
    // Static file serving
    // =========================================================================

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

    // =========================================================================
    // CORS
    // =========================================================================

    // Exact allowed origin is reflected back.
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

    // Disallowed origin gets no access-control-allow-origin header.
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

    // Preflight with allowed origin succeeds and lists expected methods/headers.
    let preflight_allowed = client
        .request(Method::OPTIONS, &label_url)
        .header(
            ORIGIN,
            HeaderValue::from_str(&allowed_origin).expect("allowed origin must parse"),
        )
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "x-api-token,content-type")
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
    assert!(
        preflight_allow_headers.contains("x-api-token"),
        "preflight allow-headers should include x-api-token"
    );

    // Preflight with disallowed origin gets no access-control-allow-origin.
    let preflight_disallowed = client
        .request(Method::OPTIONS, &label_url)
        .header(ORIGIN, HeaderValue::from_static(disallowed_origin))
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "x-api-token,content-type")
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
