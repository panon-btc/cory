//! Error types for cory-core.

use bitcoin::Txid;

// ==============================================================================
// RPC Errors
// ==============================================================================

/// Structured errors from the Bitcoin Core JSON-RPC layer.
///
/// Each variant captures a specific failure mode rather than collapsing
/// everything into a single `String`, which makes programmatic error
/// handling (e.g. retries on transport errors vs. logic errors) possible.
#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("HTTP transport: {0}")]
    Transport(#[source] reqwest::Error),

    #[error("JSON-RPC error: code={code}, message={message}")]
    ServerError { code: i64, message: String },

    #[error("invalid JSON-RPC response: {0}")]
    InvalidResponse(String),

    #[error("batch response missing item id={id}")]
    MissingBatchItem { id: u64 },
}

// ==============================================================================
// Core Errors
// ==============================================================================

/// Top-level error type for the cory-core crate.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Rpc(#[from] RpcError),

    #[error("transaction not found: {0}")]
    TxNotFound(Txid),

    #[error("invalid transaction data: {0}")]
    InvalidTxData(String),

    #[error("label parse error at line {line}: {message}")]
    LabelParse { line: usize, message: String },

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
