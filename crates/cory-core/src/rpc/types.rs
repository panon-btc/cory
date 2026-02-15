//! RPC-specific types that do not belong to the shared domain model.
//!
//! Decoded transactions and outputs are represented directly as
//! [`TxNode`] / [`TxOutput`] from `crate::types`; this module only defines
//! structures that are specific to other RPC methods.

use bitcoin::BlockHash;
use serde::Deserialize;

// ==============================================================================
// Chain Info
// ==============================================================================

/// Basic chain information from `getblockchaininfo`.
#[derive(Debug, Clone, Deserialize)]
pub struct ChainInfo {
    pub chain: String,
    pub blocks: u64,
    #[serde(rename = "bestblockhash")]
    pub best_block_hash: BlockHash,
    pub pruned: bool,
}
