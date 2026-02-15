//! Shared test helpers for `cory-core` unit tests.
//!
//! Consolidates builder functions for raw RPC types (`make_raw_tx`,
//! `simple_output`, etc.) and domain types (`make_input`, `make_output`,
//! `make_tx_node`) so that tests across modules share a single source of
//! truth for dummy data construction.

use bitcoin::hashes::Hash;
use bitcoin::{Amount, Txid};

use crate::types::{ScriptType, TxInput, TxNode, TxOutput};

// Re-export RPC intermediate types so test modules that build raw
// transactions don't need a second import line.
pub use crate::types::{RawInputInfo, RawOutputInfo, RawTxInfo};

// ==============================================================================
// Txid Helpers
// ==============================================================================

/// Create a deterministic `Txid` from a single distinguishing byte.
/// Useful for building small test graphs where txids only need to be unique.
pub fn txid_from_byte(b: u8) -> Txid {
    let mut bytes = [0u8; 32];
    bytes[0] = b;
    Txid::from_byte_array(bytes)
}

// ==============================================================================
// Raw RPC Type Builders
// ==============================================================================

/// Build a minimal `RawTxInfo` with sane defaults for test use.
/// Override individual fields after construction when needed.
pub fn make_raw_tx(
    txid: Txid,
    inputs: Vec<RawInputInfo>,
    outputs: Vec<RawOutputInfo>,
) -> RawTxInfo {
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

/// A coinbase input (no prevout).
pub fn coinbase_input() -> RawInputInfo {
    RawInputInfo {
        prevout: None,
        sequence: 0xFFFFFFFF,
        prevout_value: None,
        prevout_script: None,
    }
}

/// A spending input referencing `funding_txid:vout`.
pub fn spending_input(funding_txid: Txid, vout: u32) -> RawInputInfo {
    RawInputInfo {
        prevout: Some(bitcoin::OutPoint::new(funding_txid, vout)),
        sequence: 0xFFFFFFFE,
        prevout_value: None,
        prevout_script: None,
    }
}

/// A minimal valid P2WPKH output with the given satoshi value.
pub fn simple_output(sats: u64) -> RawOutputInfo {
    // Minimal valid P2WPKH scriptPubKey: OP_0 PUSH20 <20-byte-hash>.
    let script_bytes = [
        0x00, 0x14, // OP_0, PUSH20
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
    ];
    RawOutputInfo {
        value: Amount::from_sat(sats),
        script_pub_key: bitcoin::ScriptBuf::from_bytes(script_bytes.to_vec()),
        n: 0,
    }
}

// ==============================================================================
// Domain Type Builders (TxNode, TxInput, TxOutput)
// ==============================================================================

/// Build a `TxInput` for domain-level tests. `value` is in satoshis.
pub fn make_input(value: Option<u64>, sequence: u32) -> TxInput {
    TxInput {
        prevout: Some(bitcoin::OutPoint::new(
            Txid::from_byte_array([0u8; 32]),
            0,
        )),
        sequence,
        value: value.map(Amount::from_sat),
        script_type: Some(ScriptType::P2wpkh),
    }
}

/// Build a `TxOutput` with a P2WPKH script for domain-level tests.
pub fn make_output(sats: u64) -> TxOutput {
    let script_bytes = [
        0x00, 0x14, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
        0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
    ];
    TxOutput {
        value: Amount::from_sat(sats),
        script_pub_key: bitcoin::ScriptBuf::from_bytes(script_bytes.to_vec()),
        script_type: ScriptType::P2wpkh,
    }
}

/// Build a `TxNode` with the given inputs, outputs, and vsize.
pub fn make_tx_node(inputs: Vec<TxInput>, outputs: Vec<TxOutput>, vsize: u64) -> TxNode {
    TxNode {
        txid: Txid::from_byte_array([0u8; 32]),
        version: 2,
        locktime: 0,
        size: vsize,
        vsize,
        weight: vsize * 4,
        block_hash: None,
        block_height: Some(100),
        block_time: Some(1_700_000_000),
        inputs,
        outputs,
    }
}
