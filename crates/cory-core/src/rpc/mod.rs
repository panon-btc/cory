mod http_adapter;
#[cfg(test)]
pub mod mock;
pub mod types;

pub use http_adapter::HttpRpcClient;
pub use types::{ChainInfo, RawTxInfo, TxOutInfo};

use async_trait::async_trait;
use bitcoin::{OutPoint, Txid};

use crate::error::CoreError;

/// Minimal trait covering the Bitcoin Core RPC methods that Cory needs.
///
/// Implementations are expected to handle authentication, connection
/// management, and response deserialization internally.
#[async_trait]
pub trait BitcoinRpc: Send + Sync {
    /// Fetch a decoded transaction by txid.
    async fn get_transaction(&self, txid: &Txid) -> Result<RawTxInfo, CoreError>;

    /// Fetch a specific unspent output (for prevout resolution).
    /// Returns `None` if the output has been spent or does not exist.
    async fn get_tx_out(&self, txid: &Txid, vout: u32) -> Result<Option<TxOutInfo>, CoreError>;

    /// Fetch many outpoints efficiently. Implementations may batch these
    /// requests into a single HTTP JSON-RPC call.
    async fn get_tx_outs(
        &self,
        outpoints: &[OutPoint],
    ) -> Result<Vec<Option<TxOutInfo>>, CoreError> {
        let mut results = Vec::with_capacity(outpoints.len());
        for outpoint in outpoints {
            results.push(self.get_tx_out(&outpoint.txid, outpoint.vout).await?);
        }
        Ok(results)
    }

    /// Fetch basic chain info (network, block count, pruning status).
    async fn get_blockchain_info(&self) -> Result<ChainInfo, CoreError>;
}
