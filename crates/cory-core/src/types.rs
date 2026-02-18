//! Domain types for Cory's transaction ancestry model.
//!
//! Contains the enriched transaction types (`TxNode`, `TxInput`, `TxOutput`),
//! the ancestry graph structure (`AncestryGraph`, `AncestryEdge`), graph
//! limits, and shared enums like `ScriptType` and `BlockHeight`.

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
    P2pk,
    P2pkh,
    P2sh,
    P2wpkh,
    P2wsh,
    P2tr,
    BareMultisig,
    OpReturn,
    Unknown,
}

impl std::fmt::Display for ScriptType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::P2pk => write!(f, "p2pk"),
            Self::P2pkh => write!(f, "p2pkh"),
            Self::P2sh => write!(f, "p2sh"),
            Self::P2wpkh => write!(f, "p2wpkh"),
            Self::P2wsh => write!(f, "p2wsh"),
            Self::P2tr => write!(f, "p2tr"),
            Self::BareMultisig => write!(f, "bare_multisig"),
            Self::OpReturn => write!(f, "op_return"),
            Self::Unknown => write!(f, "unknown"),
        }
    }
}

// ==============================================================================
// Block Height
// ==============================================================================

/// A Bitcoin block height, wrapped for type safety.
///
/// `#[serde(transparent)]` preserves the JSON representation as a bare
/// integer, so this newtype is wire-compatible with plain `u32`.
/// `Deref<Target = u32>` minimises call-site churn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlockHeight(pub u32);

impl From<u32> for BlockHeight {
    fn from(h: u32) -> Self {
        Self(h)
    }
}

impl From<BlockHeight> for u32 {
    fn from(h: BlockHeight) -> Self {
        h.0
    }
}

impl std::ops::Deref for BlockHeight {
    type Target = u32;
    fn deref(&self) -> &u32 {
        &self.0
    }
}

impl std::fmt::Display for BlockHeight {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
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
    pub block_height: Option<BlockHeight>,
    pub inputs: Vec<TxInput>,
    pub outputs: Vec<TxOutput>,
}

impl TxNode {
    /// Compute confirmations relative to the current chain tip.
    /// Returns `None` for unconfirmed transactions.
    pub fn confirmations(&self, tip_height: BlockHeight) -> Option<u32> {
        self.block_height.map(|h| tip_height.saturating_sub(*h) + 1)
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
