//! In-memory LRU caches for decoded transactions and resolved prevout data.
//!
//! The cache is shared across concurrent graph-building tasks via
//! `Arc<Cache>`. Lookups mutate LRU recency state, so both operations
//! require mutable access.

use std::num::NonZeroUsize;

use bitcoin::Txid;
use lru::LruCache;
use tokio::sync::Mutex;

use crate::types::{TxNode, TxOutput};

// ==============================================================================
// Default Capacity
// ==============================================================================

/// Default maximum number of cached transactions.
const DEFAULT_TX_CAPACITY: usize = 20_000;

/// Default maximum number of cached prevout entries.
const DEFAULT_PREVOUT_CAPACITY: usize = 100_000;

// ==============================================================================
// Cache
// ==============================================================================

/// In-memory LRU caches for decoded transactions and resolved prevouts.
///
/// Shared across the graph builder and server via `Arc<Cache>`.
/// Uses `tokio::sync::Mutex` for async-friendly concurrent access.
/// Mutex and not RwLock is needed since LRU reads update recency tracking.
/// Entries are evicted in least-recently-used order when the cache is full.
pub struct Cache {
    transactions: Mutex<LruCache<Txid, TxNode>>,
    prevouts: Mutex<LruCache<(Txid, u32), TxOutput>>,
}

impl Cache {
    /// Create a cache with the default capacities
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_TX_CAPACITY, DEFAULT_PREVOUT_CAPACITY)
    }

    /// Create a cache with explicit capacities. Both values must be > 0.
    pub fn with_capacity(tx_cap: usize, prevout_cap: usize) -> Self {
        Self {
            transactions: Mutex::new(LruCache::new(
                NonZeroUsize::new(tx_cap).expect("tx capacity must be > 0"),
            )),
            prevouts: Mutex::new(LruCache::new(
                NonZeroUsize::new(prevout_cap).expect("prevout capacity must be > 0"),
            )),
        }
    }

    /// Look up a cached transaction by txid.
    ///
    /// Takes a mutex lock because LRU `get` updates recency tracking.
    pub async fn get_tx(&self, txid: &Txid) -> Option<TxNode> {
        self.transactions.lock().await.get(txid).cloned()
    }

    /// Insert a decoded transaction into the cache.
    pub async fn insert_tx(&self, txid: Txid, node: TxNode) {
        self.transactions.lock().await.put(txid, node);
    }

    /// Look up cached prevout info for a specific outpoint.
    ///
    /// Takes a mutex lock because LRU `get` updates recency tracking.
    pub async fn get_prevout(&self, txid: &Txid, vout: u32) -> Option<TxOutput> {
        self.prevouts.lock().await.get(&(*txid, vout)).cloned()
    }

    /// Cache resolved prevout data for a specific outpoint.
    pub async fn insert_prevout(&self, txid: Txid, vout: u32, info: TxOutput) {
        self.prevouts.lock().await.put((txid, vout), info);
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{make_output, make_tx_node, txid_from_byte};

    #[tokio::test]
    async fn cache_returns_none_for_unknown_txid() {
        let cache = Cache::new();
        assert!(cache.get_tx(&txid_from_byte(1)).await.is_none());
    }

    #[tokio::test]
    async fn cache_returns_inserted_tx() {
        let cache = Cache::new();
        let txid = txid_from_byte(1);
        let node = make_tx_node(vec![], vec![make_output(1000)], 100);
        cache.insert_tx(txid, node.clone()).await;

        let cached = cache.get_tx(&txid).await.expect("should be cached");
        assert_eq!(cached.txid, node.txid);
    }

    #[tokio::test]
    async fn cache_evicts_lru_entry() {
        // Capacity of 2: inserting a third entry should evict the first.
        let cache = Cache::with_capacity(2, 1);
        let txid_a = txid_from_byte(1);
        let txid_b = txid_from_byte(2);
        let txid_c = txid_from_byte(3);

        let node = make_tx_node(vec![], vec![make_output(1000)], 100);
        cache.insert_tx(txid_a, node.clone()).await;
        cache.insert_tx(txid_b, node.clone()).await;
        cache.insert_tx(txid_c, node.clone()).await;

        assert!(
            cache.get_tx(&txid_a).await.is_none(),
            "oldest should be evicted"
        );
        assert!(cache.get_tx(&txid_b).await.is_some());
        assert!(cache.get_tx(&txid_c).await.is_some());
    }

    #[tokio::test]
    async fn prevout_cache_hit_and_miss() {
        let cache = Cache::new();
        let txid = txid_from_byte(1);

        assert!(cache.get_prevout(&txid, 0).await.is_none());

        let info = make_output(5000);
        cache.insert_prevout(txid, 0, info.clone()).await;

        let cached = cache.get_prevout(&txid, 0).await.expect("should be cached");
        assert_eq!(cached.value, info.value);

        // Different vout should miss.
        assert!(cache.get_prevout(&txid, 1).await.is_none());
    }
}
