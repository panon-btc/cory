use std::num::NonZeroUsize;

use bitcoin::{Amount, ScriptBuf, Txid};
use lru::LruCache;
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
// Default Capacity
// ==============================================================================

/// Default maximum number of cached transactions.
const DEFAULT_TX_CAPACITY: usize = 10_000;

/// Default maximum number of cached prevout entries.
const DEFAULT_PREVOUT_CAPACITY: usize = 50_000;

// ==============================================================================
// Cache
// ==============================================================================

/// In-memory LRU caches for decoded transactions and resolved prevouts.
///
/// Shared across the graph builder and server via `Arc<Cache>`.
/// Uses `tokio::sync::RwLock` for async-friendly concurrent access.
/// Entries are evicted in least-recently-used order when the cache is full.
pub struct Cache {
    transactions: RwLock<LruCache<Txid, TxNode>>,
    prevouts: RwLock<LruCache<(Txid, u32), PrevoutInfo>>,
}

impl Cache {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_TX_CAPACITY, DEFAULT_PREVOUT_CAPACITY)
    }

    pub fn with_capacity(tx_cap: usize, prevout_cap: usize) -> Self {
        Self {
            transactions: RwLock::new(LruCache::new(
                NonZeroUsize::new(tx_cap).expect("tx capacity must be > 0"),
            )),
            prevouts: RwLock::new(LruCache::new(
                NonZeroUsize::new(prevout_cap).expect("prevout capacity must be > 0"),
            )),
        }
    }

    pub async fn get_tx(&self, txid: &Txid) -> Option<TxNode> {
        self.transactions.write().await.get(txid).cloned()
    }

    pub async fn insert_tx(&self, txid: Txid, node: TxNode) {
        self.transactions.write().await.put(txid, node);
    }

    pub async fn get_prevout(&self, txid: &Txid, vout: u32) -> Option<PrevoutInfo> {
        self.prevouts.write().await.get(&(*txid, vout)).cloned()
    }

    pub async fn insert_prevout(&self, txid: Txid, vout: u32, info: PrevoutInfo) {
        self.prevouts.write().await.put((txid, vout), info);
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}
