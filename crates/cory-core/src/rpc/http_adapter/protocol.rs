use crate::error::{CoreError, RpcError};

#[derive(serde::Serialize)]
pub(super) struct JsonRpcRequest<'a> {
    pub(super) jsonrpc: &'static str,
    pub(super) id: u64,
    pub(super) method: &'a str,
    pub(super) params: Vec<serde_json::Value>,
}

#[derive(serde::Serialize)]
pub(super) struct JsonRpcRequestOwned {
    pub(super) jsonrpc: &'static str,
    pub(super) id: u64,
    pub(super) method: String,
    pub(super) params: Vec<serde_json::Value>,
}

#[derive(serde::Deserialize)]
pub(super) struct JsonRpcResponse {
    pub(super) result: Option<serde_json::Value>,
    pub(super) error: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
pub(super) struct JsonRpcResponseOwned {
    pub(super) id: serde_json::Value,
    pub(super) result: Option<serde_json::Value>,
    pub(super) error: Option<serde_json::Value>,
}

/// Parse a JSON-RPC error value into a structured `CoreError`.
///
/// The JSON-RPC spec defines errors as `{"code": <int>, "message": <string>}`.
/// If the error value matches that shape, we produce a `ServerError`;
/// otherwise we fall back to `InvalidResponse` with the raw JSON.
pub(super) fn parse_jsonrpc_error(err: serde_json::Value) -> CoreError {
    #[derive(serde::Deserialize)]
    struct JsonRpcError {
        code: i64,
        message: String,
    }

    if let Ok(parsed) = serde_json::from_value::<JsonRpcError>(err.clone()) {
        CoreError::Rpc(RpcError::ServerError {
            code: parsed.code,
            message: parsed.message,
        })
    } else {
        CoreError::Rpc(RpcError::InvalidResponse(format!(
            "non-standard JSON-RPC error: {err}"
        )))
    }
}

pub(super) fn parse_batch_id(id: &serde_json::Value) -> Result<u64, CoreError> {
    if let Some(n) = id.as_u64() {
        return Ok(n);
    }

    if let Some(s) = id.as_str() {
        return s.parse::<u64>().map_err(|e| {
            RpcError::InvalidResponse(format!("invalid batch response id string: {e}")).into()
        });
    }

    Err(RpcError::InvalidResponse(format!("invalid batch response id: {id}")).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_batch_id_u64() {
        let val = serde_json::json!(42);
        assert_eq!(parse_batch_id(&val).expect("should parse"), 42);
    }

    #[test]
    fn parse_batch_id_string() {
        let val = serde_json::json!("123");
        assert_eq!(parse_batch_id(&val).expect("should parse"), 123);
    }

    #[test]
    fn parse_batch_id_invalid() {
        let val = serde_json::json!(true);
        assert!(parse_batch_id(&val).is_err());
    }
}
