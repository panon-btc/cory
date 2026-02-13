use std::collections::HashMap;

use bitcoin::{Amount, BlockHash, ScriptBuf, Txid};
use serde::{Deserialize, Serialize};

// ==============================================================================
// Script Type Classification
// ==============================================================================

/// Classifies a script output type. Delegates detection to the `bitcoin` crate's
/// `Script::is_p2pkh()`, `is_p2sh()`, etc. methods — we intentionally avoid
/// reimplementing script pattern matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptType {
    P2pkh,
    P2sh,
    P2wpkh,
    P2wsh,
    P2tr,
    OpReturn,
    Unknown,
}

impl std::fmt::Display for ScriptType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::P2pkh => write!(f, "p2pkh"),
            Self::P2sh => write!(f, "p2sh"),
            Self::P2wpkh => write!(f, "p2wpkh"),
            Self::P2wsh => write!(f, "p2wsh"),
            Self::P2tr => write!(f, "p2tr"),
            Self::OpReturn => write!(f, "op_return"),
            Self::Unknown => write!(f, "unknown"),
        }
    }
}

// ==============================================================================
// Transaction Types
// ==============================================================================

/// A transaction node in the ancestry graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxNode {
    pub txid: Txid,
    pub version: i32,
    pub locktime: u32,
    pub size: u64,
    pub vsize: u64,
    pub weight: u64,
    pub block_hash: Option<BlockHash>,
    /// Block height; `None` for unconfirmed (mempool) transactions.
    pub block_height: Option<u32>,
    pub block_time: Option<u64>,
    pub inputs: Vec<TxInput>,
    pub outputs: Vec<TxOutput>,
}

impl TxNode {
    /// Compute confirmations relative to the current chain tip.
    /// Returns `None` for unconfirmed transactions.
    pub fn confirmations(&self, tip_height: u32) -> Option<u32> {
        self.block_height.map(|h| tip_height.saturating_sub(h) + 1)
    }

    /// A coinbase transaction has exactly one input whose prevout is `None`.
    pub fn is_coinbase(&self) -> bool {
        self.inputs.len() == 1 && self.inputs[0].prevout.is_none()
    }
}

/// A transaction input. For coinbase inputs, `prevout` is `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxInput {
    /// The outpoint being spent. `None` for coinbase inputs.
    pub prevout: Option<bitcoin::OutPoint>,
    pub sequence: u32,
    /// Value of the spent output, resolved from the funding transaction.
    /// May be `None` if prevout resolution failed.
    pub value: Option<Amount>,
    /// Script type of the spent output.
    pub script_type: Option<ScriptType>,
}

/// A transaction output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxOutput {
    pub value: Amount,
    pub script_pub_key: ScriptBuf,
    pub script_type: ScriptType,
}

// ==============================================================================
// Ancestry Graph
// ==============================================================================

/// A directed acyclic graph of transaction spending ancestry.
///
/// Starting from a root transaction, the graph traces backwards through
/// each input's outpoint to the funding transaction, recursively, until
/// hitting coinbase transactions or configured limits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AncestryGraph {
    pub nodes: HashMap<Txid, TxNode>,
    pub edges: Vec<AncestryEdge>,
    pub root_txid: Txid,
    /// `true` when the graph was cut short by a limit.
    pub truncated: bool,
    pub stats: GraphStats,
}

/// An edge in the ancestry DAG: "spending_txid's input at input_index
/// spends funding_txid's output at funding_vout."
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AncestryEdge {
    pub spending_txid: Txid,
    pub input_index: u32,
    pub funding_txid: Txid,
    pub funding_vout: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphStats {
    pub node_count: usize,
    pub edge_count: usize,
    pub max_depth_reached: usize,
}

/// Configurable limits for ancestry graph expansion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphLimits {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_edges: usize,
}

impl Default for GraphLimits {
    fn default() -> Self {
        Self {
            max_depth: 50,
            max_nodes: 500,
            max_edges: 2000,
        }
    }
}

// ==============================================================================
// RPC Intermediate Types
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
    pub block_height: Option<u32>,
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
