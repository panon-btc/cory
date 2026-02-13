use std::collections::HashMap;

use async_trait::async_trait;
use bitcoin::hashes::Hash;
use bitcoin::{BlockHash, OutPoint, Txid};

use crate::error::CoreError;
use crate::types::{ChainInfo, RawTxInfo, TxOutInfo};

use super::BitcoinRpc;

/// A mock Bitcoin RPC backend for testing. Returns canned transaction data
/// from a `HashMap` populated via the builder pattern.
pub struct MockRpc {
    transactions: HashMap<Txid, RawTxInfo>,
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

pub struct MockRpcBuilder {
    transactions: HashMap<Txid, RawTxInfo>,
    chain_info: ChainInfo,
}

impl MockRpcBuilder {
    pub fn with_tx(mut self, tx: RawTxInfo) -> Self {
        self.transactions.insert(tx.txid, tx);
        self
    }

    pub fn with_chain_info(mut self, info: ChainInfo) -> Self {
        self.chain_info = info;
        self
    }

    pub fn build(self) -> MockRpc {
        MockRpc {
            transactions: self.transactions,
            chain_info: self.chain_info,
        }
    }
}

#[async_trait]
impl BitcoinRpc for MockRpc {
    async fn get_transaction(&self, txid: &Txid) -> Result<RawTxInfo, CoreError> {
        self.transactions
            .get(txid)
            .cloned()
            .ok_or(CoreError::TxNotFound(*txid))
    }

    async fn get_tx_out(&self, txid: &Txid, vout: u32) -> Result<Option<TxOutInfo>, CoreError> {
        // Look up the transaction and return the output at the given index.
        let tx = match self.transactions.get(txid) {
            Some(tx) => tx,
            None => return Ok(None),
        };
        let output = match tx.outputs.get(vout as usize) {
            Some(o) => o,
            None => return Ok(None),
        };
        Ok(Some(TxOutInfo {
            value: output.value,
            script_pub_key: output.script_pub_key.clone(),
            confirmations: tx.confirmations.unwrap_or(0),
            coinbase: tx.inputs.len() == 1 && tx.inputs[0].prevout.is_none(),
        }))
    }

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

    async fn get_blockchain_info(&self) -> Result<ChainInfo, CoreError> {
        Ok(self.chain_info.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RawInputInfo, RawOutputInfo};
    use bitcoin::Amount;

    fn txid_from_byte(b: u8) -> Txid {
        let mut bytes = [0u8; 32];
        bytes[0] = b;
        Txid::from_byte_array(bytes)
    }

    fn simple_output(sats: u64) -> RawOutputInfo {
        let script_bytes = [
            0x00, 0x14, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
            0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
        ];
        RawOutputInfo {
            value: Amount::from_sat(sats),
            script_pub_key: bitcoin::ScriptBuf::from_bytes(script_bytes.to_vec()),
            n: 0,
        }
    }

    fn make_tx(txid: Txid, inputs: Vec<RawInputInfo>, outputs: Vec<RawOutputInfo>) -> RawTxInfo {
        RawTxInfo {
            txid,
            version: 2,
            locktime: 0,
            size: 250,
            vsize: 140,
            weight: 560,
            block_hash: None,
            block_height: Some(100),
            block_time: Some(1_700_000_000),
            confirmations: Some(10),
            inputs,
            outputs,
        }
    }

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
        let mut out0 = simple_output(5000);
        out0.n = 0;
        let mut out1 = simple_output(3000);
        out1.n = 1;

        let tx = make_tx(
            txid,
            vec![RawInputInfo {
                prevout: None,
                sequence: 0xFFFFFFFF,
                prevout_value: None,
                prevout_script: None,
            }],
            vec![out0, out1],
        );

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
