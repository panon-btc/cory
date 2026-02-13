use std::collections::HashMap;

use bitcoin::{Amount, ScriptBuf, Txid};
use tokio::sync::RwLock;

use crate::types::{ScriptType, TxNode};

// ==============================================================================
// Prevout Cache Entry
// ==============================================================================

/// Cached information about a previous output, used to enrich inputs
/// with value and script type without re-fetching the full transaction.
#[derive(Debug, Clone)]
pub struct PrevoutInfo {
    pub value: Amount,
    pub script_pub_key: ScriptBuf,
    pub script_type: ScriptType,
}

// ==============================================================================
// Cache
// ==============================================================================

/// In-memory caches for decoded transactions and resolved prevouts.
///
/// Shared across the graph builder and server via `Arc<Cache>`.
/// Uses `tokio::sync::RwLock` for async-friendly concurrent access.
pub struct Cache {
    transactions: RwLock<HashMap<Txid, TxNode>>,
    prevouts: RwLock<HashMap<(Txid, u32), PrevoutInfo>>,
}

impl Cache {
    pub fn new() -> Self {
        Self {
            transactions: RwLock::new(HashMap::new()),
            prevouts: RwLock::new(HashMap::new()),
        }
    }

    pub async fn get_tx(&self, txid: &Txid) -> Option<TxNode> {
        self.transactions.read().await.get(txid).cloned()
    }

    pub async fn insert_tx(&self, txid: Txid, node: TxNode) {
        self.transactions.write().await.insert(txid, node);
    }

    pub async fn get_prevout(&self, txid: &Txid, vout: u32) -> Option<PrevoutInfo> {
        self.prevouts.read().await.get(&(*txid, vout)).cloned()
    }

    pub async fn insert_prevout(&self, txid: Txid, vout: u32, info: PrevoutInfo) {
        self.prevouts.write().await.insert((txid, vout), info);
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}
