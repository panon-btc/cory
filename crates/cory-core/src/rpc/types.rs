//! Wire-format types used to shuttle data between the Bitcoin Core
//! JSON-RPC layer and the graph builder. These are intermediate
//! representations — not the enriched domain types exposed by the
//! public API.

use bitcoin::{Amount, BlockHash, ScriptBuf, Txid};

use crate::types::BlockHeight;

// ==============================================================================
// Decoded Transaction
// ==============================================================================

/// Intermediate representation of a decoded transaction from RPC.
/// Owned by cory-core, independent of the RPC library's response shapes.
#[derive(Debug, Clone)]
pub struct RawTxInfo {
    pub txid: Txid,
    pub version: i32,
    pub locktime: u32,
    pub size: u64,
    pub vsize: u64,
    pub weight: u64,
    pub block_hash: Option<BlockHash>,
    pub block_height: Option<BlockHeight>,
    pub block_time: Option<u64>,
    pub confirmations: Option<u64>,
    pub inputs: Vec<RawInputInfo>,
    pub outputs: Vec<RawOutputInfo>,
}

#[derive(Debug, Clone)]
pub struct RawInputInfo {
    pub prevout: Option<bitcoin::OutPoint>,
    pub sequence: u32,
    /// Value from the prevout, if the RPC provided it (verbosity=2).
    pub prevout_value: Option<Amount>,
    /// scriptPubKey of the prevout, if the RPC provided it.
    pub prevout_script: Option<ScriptBuf>,
}

#[derive(Debug, Clone)]
pub struct RawOutputInfo {
    pub value: Amount,
    pub script_pub_key: ScriptBuf,
    pub n: u32,
}

// ==============================================================================
// UTXO and Chain Info
// ==============================================================================

/// UTXO information from `gettxout`.
#[derive(Debug, Clone)]
pub struct TxOutInfo {
    pub value: Amount,
    pub script_pub_key: ScriptBuf,
    pub confirmations: u64,
    pub coinbase: bool,
}

/// Basic chain information from `getblockchaininfo`.
#[derive(Debug, Clone)]
pub struct ChainInfo {
    pub chain: String,
    pub blocks: u64,
    pub best_block_hash: BlockHash,
    pub pruned: bool,
}
