//! Mock [`BitcoinRpc`] implementation for unit tests.
//!
//! Uses a builder pattern (`MockRpc::builder()`) to register canned
//! transactions and chain info before the mock is consumed.

use std::collections::HashMap;

use async_trait::async_trait;
use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, OutPoint, Txid};

use crate::error::CoreError;
use crate::types::{TxNode, TxOutput};

use super::types::ChainInfo;
use super::BitcoinRpc;

/// A mock Bitcoin RPC backend for testing. Returns canned transaction data
/// from a `HashMap` populated via the builder pattern.
pub struct MockRpc {
    transactions: HashMap<Txid, TxNode>,
    chain_info: ChainInfo,
}

impl MockRpc {
    pub fn builder() -> MockRpcBuilder {
        MockRpcBuilder {
            transactions: HashMap::new(),
            chain_info: ChainInfo {
                chain: "regtest".into(),
                blocks: 100,
                best_block_hash: BlockHash::all_zeros(),
                pruned: false,
            },
        }
    }
}

/// Builder for configuring a [`MockRpc`] with canned data.
pub struct MockRpcBuilder {
    transactions: HashMap<Txid, TxNode>,
    chain_info: ChainInfo,
}

impl MockRpcBuilder {
    /// Register a transaction, keyed by its `txid`.
    pub fn with_tx(mut self, tx: TxNode) -> Self {
        self.transactions.insert(tx.txid, tx);
        self
    }

    /// Override the default chain info (regtest, 100 blocks).
    pub fn with_chain_info(mut self, info: ChainInfo) -> Self {
        self.chain_info = info;
        self
    }

    /// Consume the builder and produce a [`MockRpc`].
    pub fn build(self) -> MockRpc {
        MockRpc {
            transactions: self.transactions,
            chain_info: self.chain_info,
        }
    }
}

#[async_trait]
impl BitcoinRpc for MockRpc {
    async fn get_transaction(&self, txid: &Txid) -> Result<TxNode, CoreError> {
        self.transactions
            .get(txid)
            .cloned()
            .ok_or(CoreError::TxNotFound(*txid))
    }

    async fn get_tx_out(&self, txid: &Txid, vout: u32) -> Result<Option<TxOutput>, CoreError> {
        // Look up the transaction and return the output at the given index.
        let tx = match self.transactions.get(txid) {
            Some(tx) => tx,
            None => return Ok(None),
        };
        let output = match tx.outputs.get(vout as usize) {
            Some(o) => o.clone(),
            None => return Ok(None),
        };
        Ok(Some(output))
    }

    async fn get_tx_outs(
        &self,
        outpoints: &[OutPoint],
    ) -> Result<Vec<Option<TxOutput>>, CoreError> {
        let mut results = Vec::with_capacity(outpoints.len());
        for outpoint in outpoints {
            results.push(self.get_tx_out(&outpoint.txid, outpoint.vout).await?);
        }
        Ok(results)
    }

    async fn get_blockchain_info(&self) -> Result<ChainInfo, CoreError> {
        Ok(self.chain_info.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;
    use bitcoin::Amount;

    #[tokio::test]
    async fn with_chain_info_overrides_defaults() {
        let custom_info = ChainInfo {
            chain: "mainnet".into(),
            blocks: 800_000,
            best_block_hash: BlockHash::all_zeros(),
            pruned: true,
        };
        let rpc = MockRpc::builder()
            .with_chain_info(custom_info.clone())
            .build();
        let info = rpc.get_blockchain_info().await.unwrap();
        assert_eq!(info.chain, "mainnet");
        assert_eq!(info.blocks, 800_000);
        assert!(info.pruned);
    }

    #[tokio::test]
    async fn get_tx_outs_returns_batch_results() {
        let txid = txid_from_byte(1);
        let out0 = simple_output(5000);
        let out1 = simple_output(3000);

        let tx = make_raw_tx(txid, vec![coinbase_input()], vec![out0, out1]);

        let rpc = MockRpc::builder().with_tx(tx).build();
        let outpoints = vec![
            OutPoint::new(txid, 0),
            OutPoint::new(txid, 1),
            OutPoint::new(txid, 99), // does not exist
        ];
        let results = rpc.get_tx_outs(&outpoints).await.unwrap();
        assert_eq!(results.len(), 3);
        assert!(results[0].is_some());
        assert_eq!(results[0].as_ref().unwrap().value, Amount::from_sat(5000));
        assert!(results[1].is_some());
        assert_eq!(results[1].as_ref().unwrap().value, Amount::from_sat(3000));
        assert!(results[2].is_none());
    }
}
