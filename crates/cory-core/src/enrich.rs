//! Transaction enrichment and analysis utilities.
//!
//! Provides script classification, fee/feerate computation, RBF signaling
//! detection, and locktime interpretation.

use bitcoin::{Amount, Script};
use serde::{Deserialize, Serialize};

use crate::types::{ScriptType, TxNode};

// ==============================================================================
// Script Classification
// ==============================================================================

/// Classify a script using the `bitcoin` crate's built-in detection methods.
/// We intentionally delegate all pattern matching to the bitcoin crate rather
/// than reimplementing opcode-level checks.
#[must_use]
pub fn classify_script(script: &Script) -> ScriptType {
    if script.is_p2pk() {
        ScriptType::P2pk
    } else if script.is_p2pkh() {
        ScriptType::P2pkh
    } else if script.is_p2sh() {
        ScriptType::P2sh
    } else if script.is_p2wpkh() {
        ScriptType::P2wpkh
    } else if script.is_p2wsh() {
        ScriptType::P2wsh
    } else if script.is_p2tr() {
        ScriptType::P2tr
    } else if script.is_multisig() {
        ScriptType::BareMultisig
    } else if script.is_op_return() {
        ScriptType::OpReturn
    } else {
        ScriptType::Unknown
    }
}

// ==============================================================================
// Fee and Feerate
// ==============================================================================

/// Compute the transaction fee as sum(inputs) - sum(outputs).
/// Returns `None` if any input is missing its resolved value (e.g. a coinbase
/// transaction, or an input whose prevout was not resolved).
#[must_use]
pub fn compute_fee(tx: &TxNode) -> Option<Amount> {
    let total_in = tx
        .inputs
        .iter()
        .try_fold(Amount::ZERO, |acc, input| acc.checked_add(input.value?))?;

    let total_out = tx
        .outputs
        .iter()
        .try_fold(Amount::ZERO, |acc, output| acc.checked_add(output.value))?;

    total_in.checked_sub(total_out)
}

/// Compute the feerate in sat/vB.
#[must_use]
pub fn compute_feerate(fee: Amount, vsize: u64) -> f64 {
    if vsize == 0 {
        return 0.0;
    }
    fee.to_sat() as f64 / vsize as f64
}

// ==============================================================================
// RBF and Locktime
// ==============================================================================

/// A transaction signals opt-in RBF if any input has a sequence number
/// less than `0xFFFFFFFE` (i.e., not final and not opting out).
#[must_use]
pub fn is_rbf_signaling(tx: &TxNode) -> bool {
    tx.inputs.iter().any(|input| input.sequence < 0xFFFFFFFE)
}

/// Decoded locktime information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocktimeInfo {
    /// The raw locktime value.
    pub raw: u32,
    /// Whether the locktime is interpreted as a block height (< 500_000_000)
    /// or a Unix timestamp (>= 500_000_000).
    pub kind: LocktimeKind,
    /// Whether the locktime has any effect. A locktime of 0 is disabled,
    /// and the locktime is only enforced if at least one input has a
    /// non-final sequence number.
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocktimeKind {
    Disabled,
    BlockHeight,
    Timestamp,
}

/// Interpret the locktime field of a transaction.
///
/// The `has_non_final_sequence` parameter should be `true` if at least
/// one input has `sequence < 0xFFFFFFFF`, which is required for the
/// locktime to actually be enforced.
#[must_use]
pub fn locktime_info(locktime: u32, has_non_final_sequence: bool) -> LocktimeInfo {
    if locktime == 0 {
        return LocktimeInfo {
            raw: 0,
            kind: LocktimeKind::Disabled,
            active: false,
        };
    }

    let kind = if locktime < 500_000_000 {
        LocktimeKind::BlockHeight
    } else {
        LocktimeKind::Timestamp
    };

    LocktimeInfo {
        raw: locktime,
        kind,
        active: has_non_final_sequence,
    }
}

/// Derive a display identifier (address or data) for a script.
///
/// For standard scripts, this returns the Bitcoin address string.
/// For P2PK scripts, it returns the corresponding P2PKH address string.
/// For OP_RETURN scripts, it attempts to return the decoded ASCII data.
#[must_use]
pub fn derive_display_id(script: &bitcoin::Script, network: bitcoin::Network) -> Option<String> {
    if let Ok(address) = bitcoin::Address::from_script(script, network) {
        return Some(address.to_string());
    }

    // Fallback for P2PK: extract pubkey and return P2PKH address string
    if script.is_p2pk() {
        let bytes = script.as_bytes();
        if bytes.len() > 2 {
            // P2PK is <len> <pubkey> OP_CHECKSIG
            let pubkey_bytes = &bytes[1..bytes.len() - 1];
            if let Ok(pubkey) = bitcoin::PublicKey::from_slice(pubkey_bytes) {
                return Some(bitcoin::Address::p2pkh(&pubkey, network).to_string());
            }
        }
    }

    // Fallback for OP_RETURN: try to decode ASCII data
    if script.is_op_return() {
        for instruction in script.instructions() {
            if let Ok(bitcoin::script::Instruction::PushBytes(b)) = instruction {
                let bytes = b.as_bytes();
                if !bytes.is_empty() && bytes.iter().all(|&b| b.is_ascii() && !b.is_ascii_control())
                {
                    if let Ok(s) = std::str::from_utf8(bytes) {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{make_input, make_output, make_tx_node};
    use crate::types::TxInput;

    // -- compute_fee tests ----------------------------------------------------

    #[test]
    fn compute_fee_basic() {
        let tx = make_tx_node(
            vec![make_input(Some(5000), 0xFFFFFFFE)],
            vec![make_output(3000)],
            140,
        );
        let fee = compute_fee(&tx).unwrap();
        assert_eq!(fee, Amount::from_sat(2000));
    }

    #[test]
    fn compute_fee_multiple_inputs_outputs() {
        let tx = make_tx_node(
            vec![
                make_input(Some(5000), 0xFFFFFFFE),
                make_input(Some(3000), 0xFFFFFFFE),
            ],
            vec![make_output(4000), make_output(2000)],
            200,
        );
        let fee = compute_fee(&tx).unwrap();
        assert_eq!(fee, Amount::from_sat(2000));
    }

    #[test]
    fn compute_fee_returns_none_when_input_value_missing() {
        let tx = make_tx_node(
            vec![
                make_input(Some(5000), 0xFFFFFFFE),
                make_input(None, 0xFFFFFFFE),
            ],
            vec![make_output(3000)],
            140,
        );
        assert!(compute_fee(&tx).is_none());
    }

    #[test]
    fn compute_fee_returns_none_for_coinbase() {
        let tx = make_tx_node(
            vec![TxInput {
                prevout: None,
                sequence: 0xFFFFFFFF,
                value: None,
                script_type: None,
            }],
            vec![make_output(50_0000_0000)],
            140,
        );
        assert!(compute_fee(&tx).is_none());
    }

    // -- compute_feerate tests ------------------------------------------------

    #[test]
    fn compute_feerate_basic() {
        let rate = compute_feerate(Amount::from_sat(1000), 140);
        let expected = 1000.0 / 140.0;
        assert!((rate - expected).abs() < f64::EPSILON);
    }

    #[test]
    fn compute_feerate_zero_vsize() {
        let rate = compute_feerate(Amount::from_sat(1000), 0);
        assert_eq!(rate, 0.0);
    }

    // -- is_rbf_signaling tests -----------------------------------------------

    #[test]
    fn rbf_signaling_with_non_final_sequence() {
        let tx = make_tx_node(
            vec![make_input(Some(5000), 0xFFFFFFFD)],
            vec![make_output(3000)],
            140,
        );
        assert!(is_rbf_signaling(&tx));
    }

    #[test]
    fn no_rbf_signaling_when_sequence_is_final() {
        let tx = make_tx_node(
            vec![make_input(Some(5000), 0xFFFFFFFF)],
            vec![make_output(3000)],
            140,
        );
        assert!(!is_rbf_signaling(&tx));
    }

    #[test]
    fn no_rbf_signaling_when_sequence_is_opt_out() {
        let tx = make_tx_node(
            vec![make_input(Some(5000), 0xFFFFFFFE)],
            vec![make_output(3000)],
            140,
        );
        assert!(!is_rbf_signaling(&tx));
    }

    // -- locktime tests -------------------------------------------------------

    #[test]
    fn locktime_zero_is_disabled() {
        let info = locktime_info(0, true);
        assert_eq!(info.kind, LocktimeKind::Disabled);
        assert!(!info.active);
    }

    #[test]
    fn locktime_block_height() {
        let info = locktime_info(800_000, true);
        assert_eq!(info.kind, LocktimeKind::BlockHeight);
        assert!(info.active);
    }

    #[test]
    fn locktime_timestamp() {
        let info = locktime_info(1_700_000_000, true);
        assert_eq!(info.kind, LocktimeKind::Timestamp);
        assert!(info.active);
    }

    #[test]
    fn locktime_inactive_when_all_sequences_final() {
        let info = locktime_info(800_000, false);
        assert_eq!(info.kind, LocktimeKind::BlockHeight);
        assert!(!info.active);
    }

    // -- classify_script tests ------------------------------------------------

    #[test]
    fn derive_display_id_p2pk() {
        let network = bitcoin::Network::Bitcoin;
        // PUSH65 <65-byte-uncompressed-key> OP_CHECKSIG
        let mut bytes = vec![0x41];
        let pubkey_bytes = [
            0x04, 0x01, 0x51, 0x8f, 0xa1, 0xd1, 0xe1, 0xe3, 0xe1, 0x62, 0x85, 0x2d, 0x68, 0xd9,
            0xbe, 0x1c, 0x0a, 0xba, 0xd5, 0xe3, 0xd6, 0x29, 0x7e, 0xc9, 0x5f, 0x1f, 0x91, 0xb9,
            0x09, 0xdc, 0x1a, 0xfe, 0x61, 0x6d, 0x68, 0x76, 0xf9, 0x29, 0x18, 0x45, 0x1c, 0xa3,
            0x87, 0xc4, 0x38, 0x76, 0x09, 0xae, 0x1a, 0x89, 0x50, 0x07, 0x09, 0x61, 0x95, 0xa8,
            0x24, 0xba, 0xf9, 0xc3, 0x8e, 0xa9, 0x8c, 0x09, 0xc3,
        ];
        bytes.extend_from_slice(&pubkey_bytes);
        bytes.push(0xac);
        let script = bitcoin::ScriptBuf::from_bytes(bytes);

        let id = derive_display_id(script.as_script(), network).expect("should derive display id");
        assert_eq!(id, "1LzBzVqEeuQyjD2mRWHes3dgWrT9titxvq");
    }

    #[test]
    fn derive_display_id_op_return_ascii() {
        let network = bitcoin::Network::Bitcoin;
        // OP_RETURN PUSH "hello"
        let script = bitcoin::ScriptBuf::from_bytes(vec![0x6a, 0x05, b'h', b'e', b'l', b'l', b'o']);
        let id = derive_display_id(script.as_script(), network).expect("should derive display id");
        assert_eq!(id, "hello");
    }

    #[test]
    fn classify_p2pk_script() {
        // PUSH65 <65-byte-uncompressed-key> OP_CHECKSIG
        let mut bytes = vec![0x41];
        bytes.extend_from_slice(&[0x04; 65]);
        bytes.push(0xac);
        let script = bitcoin::ScriptBuf::from_bytes(bytes);
        assert_eq!(classify_script(script.as_script()), ScriptType::P2pk);
    }

    #[test]
    fn classify_p2wpkh_script() {
        // OP_0 PUSH20 <20-byte-hash>
        let script = bitcoin::ScriptBuf::from_bytes(vec![
            0x00, 0x14, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
            0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
        ]);
        assert_eq!(classify_script(script.as_script()), ScriptType::P2wpkh);
    }

    #[test]
    fn classify_p2tr_script() {
        // OP_1 PUSH32 <32-byte-key>
        let mut bytes = vec![0x51, 0x20];
        bytes.extend_from_slice(&[0xAA; 32]);
        let script = bitcoin::ScriptBuf::from_bytes(bytes);
        assert_eq!(classify_script(script.as_script()), ScriptType::P2tr);
    }

    #[test]
    fn classify_op_return_script() {
        // OP_RETURN followed by arbitrary data.
        let script = bitcoin::ScriptBuf::from_bytes(vec![0x6a, 0x04, 0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(classify_script(script.as_script()), ScriptType::OpReturn);
    }

    #[test]
    fn classify_unknown_script() {
        // An empty script doesn't match any known pattern.
        let script = bitcoin::ScriptBuf::new();
        assert_eq!(classify_script(script.as_script()), ScriptType::Unknown);
    }
}
