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
    if script.is_p2pkh() {
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
    let mut total_in = Amount::ZERO;
    for input in &tx.inputs {
        total_in = total_in.checked_add(input.value?)?;
    }

    let mut total_out = Amount::ZERO;
    for output in &tx.outputs {
        total_out = total_out.checked_add(output.value)?;
    }

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
}
