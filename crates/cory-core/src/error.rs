use bitcoin::Txid;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("RPC communication failure: {0}")]
    Rpc(String),

    #[error("transaction not found: {0}")]
    TxNotFound(Txid),

    #[error("invalid transaction data: {0}")]
    InvalidTxData(String),

    #[error("label parse error at line {line}: {message}")]
    LabelParse { line: usize, message: String },

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
