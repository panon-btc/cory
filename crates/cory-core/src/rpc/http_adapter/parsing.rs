use bitcoin::{Amount, BlockHash, OutPoint, ScriptBuf, Txid};

use crate::enrich::classify_script;
use crate::error::CoreError;
use crate::types::{TxInput, TxOutput};

#[derive(serde::Deserialize)]
struct TxOutResponse {
    value: serde_json::Value,
    #[serde(rename = "scriptPubKey")]
    script_pubkey: serde_json::Value,
}

pub(super) fn parse_gettxout_result(raw: serde_json::Value) -> Result<Option<TxOutput>, CoreError> {
    if raw.is_null() {
        return Ok(None);
    }

    let response: TxOutResponse = serde_json::from_value(raw)
        .map_err(|e| CoreError::InvalidTxData(format!("invalid gettxout result: {e}")))?;

    let value = parse_btc_amount(&response.value)?;
    let script_pub_key = parse_script_pubkey_from_json(&response.script_pubkey)?;
    let script_type = classify_script(script_pub_key.as_script());

    Ok(Some(TxOutput {
        value,
        script_pub_key,
        script_type,
    }))
}

pub(super) fn parse_txid(
    value: Option<&serde_json::Value>,
    field: &str,
) -> Result<Txid, CoreError> {
    let value = value
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidTxData(format!("missing {field}")))?;
    value
        .parse()
        .map_err(|e| CoreError::InvalidTxData(format!("invalid {field}: {e}")))
}

pub(super) fn parse_opt_block_hash(
    value: Option<&serde_json::Value>,
) -> Result<Option<BlockHash>, CoreError> {
    match value.and_then(serde_json::Value::as_str) {
        None => Ok(None),
        Some(s) => s
            .parse()
            .map(Some)
            .map_err(|e| CoreError::InvalidTxData(format!("invalid blockhash: {e}"))),
    }
}

pub(super) fn parse_integer_required<T, const SIGNED: bool>(
    value: Option<&serde_json::Value>,
    field: &str,
) -> Result<T, CoreError>
where
    T: TryFrom<i64> + TryFrom<u64>,
{
    parse_integer::<T, SIGNED, true>(value, field)?
        .ok_or_else(|| CoreError::InvalidTxData(format!("missing {field}")))
}

pub(super) fn parse_integer_optional<T, const SIGNED: bool>(
    value: Option<&serde_json::Value>,
) -> Option<T>
where
    T: TryFrom<i64> + TryFrom<u64>,
{
    parse_integer::<T, SIGNED, false>(value, "value")
        .ok()
        .flatten()
}

// Generic integer parser used by all concrete numeric helpers.
// `required=false` treats missing/null/type-mismatch as `Ok(None)`.
fn parse_integer<T, const SIGNED: bool, const REQUIRED: bool>(
    value: Option<&serde_json::Value>,
    field: &str,
) -> Result<Option<T>, CoreError>
where
    T: TryFrom<i64> + TryFrom<u64>,
{
    let missing_or_none = || {
        if REQUIRED {
            Err(CoreError::InvalidTxData(format!("missing {field}")))
        } else {
            Ok(None)
        }
    };

    let Some(value) = value else {
        return missing_or_none();
    };

    if SIGNED {
        let Some(n) = value.as_i64() else {
            return missing_or_none();
        };
        T::try_from(n)
            .map(Some)
            .map_err(|_| CoreError::InvalidTxData(format!("{field} out of range: {n}")))
    } else {
        let Some(n) = value.as_u64() else {
            return missing_or_none();
        };
        T::try_from(n)
            .map(Some)
            .map_err(|_| CoreError::InvalidTxData(format!("{field} out of range: {n}")))
    }
}

pub(super) fn parse_vin(vin: &[serde_json::Value]) -> Result<Vec<TxInput>, CoreError> {
    vin.iter()
        .map(|input| {
            let sequence = parse_integer_required::<u32, false>(input.get("sequence"), "sequence")?;
            let is_coinbase = input.get("coinbase").is_some();

            let prevout = if is_coinbase {
                None
            } else {
                let prev_txid = parse_txid(input.get("txid"), "vin.txid")?;
                let prev_vout =
                    parse_integer_required::<u32, false>(input.get("vout"), "vin.vout")?;
                Some(OutPoint::new(prev_txid, prev_vout))
            };

            let prevout_value = input
                .get("prevout")
                .and_then(|p| p.get("value"))
                .and_then(|v| parse_btc_amount(v).ok());

            let script_type = input
                .get("prevout")
                .and_then(|p| p.get("scriptPubKey"))
                .and_then(|s| s.get("hex"))
                .and_then(serde_json::Value::as_str)
                .and_then(|hex_str| script_from_hex(hex_str).ok())
                .map(|script| classify_script(script.as_script()));

            Ok(TxInput {
                prevout,
                sequence,
                value: prevout_value,
                script_type,
            })
        })
        .collect()
}

pub(super) fn parse_vout(vout: &[serde_json::Value]) -> Result<Vec<TxOutput>, CoreError> {
    vout.iter()
        .map(|output| {
            let value = parse_btc_amount(
                output
                    .get("value")
                    .ok_or_else(|| CoreError::InvalidTxData("missing value in vout".into()))?,
            )?;

            let script =
                parse_script_pubkey_from_json(output.get("scriptPubKey").ok_or_else(|| {
                    CoreError::InvalidTxData("missing scriptPubKey in vout".into())
                })?)?;
            let script_type = classify_script(script.as_script());
            // We intentionally rely on array position for `vout` indexing.
            // TODO: Validate `vout.n` sequencing if we need stricter RPC checks.

            Ok(TxOutput {
                value,
                script_pub_key: script,
                script_type,
            })
        })
        .collect()
}

fn parse_script_pubkey_from_json(spk: &serde_json::Value) -> Result<ScriptBuf, CoreError> {
    let hex_str = spk
        .get("hex")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidTxData("missing hex in scriptPubKey".into()))?;
    script_from_hex(hex_str)
}

fn script_from_hex(hex_str: &str) -> Result<ScriptBuf, CoreError> {
    ScriptBuf::from_hex(hex_str)
        .map_err(|e| CoreError::InvalidTxData(format!("invalid scriptPubKey hex: {e}")))
}

/// Parse a BTC amount from a JSON value.
///
/// Number values are parsed via `Amount::from_float_in` to support scientific
/// notation, while string values are parsed via `Amount::from_str_in`.
pub(super) fn parse_btc_amount(value: &serde_json::Value) -> Result<Amount, CoreError> {
    match value {
        serde_json::Value::Number(n) => {
            let parsed = n
                .as_f64()
                .ok_or_else(|| CoreError::InvalidTxData(format!("invalid BTC amount `{value}`")))?;
            Amount::from_float_in(parsed, bitcoin::Denomination::Bitcoin)
                .map_err(|e| CoreError::InvalidTxData(format!("invalid BTC amount `{value}`: {e}")))
        }
        serde_json::Value::String(s) => Amount::from_str_in(s, bitcoin::Denomination::Bitcoin)
            .map_err(|e| CoreError::InvalidTxData(format!("invalid BTC amount `{s}`: {e}"))),
        _ => Err(CoreError::InvalidTxData(format!(
            "expected numeric BTC amount, got: {value}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use bitcoin::Amount;

    use super::*;

    #[test]
    fn parse_btc_amount_integer() {
        let val = serde_json::json!(1);
        let amount = parse_btc_amount(&val).expect("should parse integer");
        assert_eq!(amount, Amount::from_btc(1.0).expect("valid"));
    }

    #[test]
    fn parse_btc_amount_fractional() {
        let val = serde_json::json!(0.00001);
        let amount = parse_btc_amount(&val).expect("should parse fractional");
        assert_eq!(amount, Amount::from_sat(1000));
    }

    #[test]
    fn parse_btc_amount_string() {
        let val = serde_json::json!("0.5");
        let amount = parse_btc_amount(&val).expect("should parse string");
        assert_eq!(amount, Amount::from_btc(0.5).expect("valid"));
    }

    #[test]
    fn parse_btc_amount_zero() {
        let val = serde_json::json!(0);
        let amount = parse_btc_amount(&val).expect("should parse zero");
        assert_eq!(amount, Amount::ZERO);
    }

    #[test]
    fn parse_btc_amount_invalid() {
        let val = serde_json::json!(true);
        assert!(parse_btc_amount(&val).is_err());
    }

    #[test]
    fn parse_btc_amount_scientific_number() {
        let val = serde_json::json!(6.6e-6);
        let amount = parse_btc_amount(&val).expect("should parse scientific notation");
        assert_eq!(amount, Amount::from_sat(660));
    }

    #[test]
    fn parse_btc_amount_scientific_string() {
        let val = serde_json::json!("1e-8");
        assert!(parse_btc_amount(&val).is_err());
    }

    #[test]
    fn parse_gettxout_result_null() {
        let val = serde_json::Value::Null;
        let result = parse_gettxout_result(val).expect("should parse null");
        assert!(result.is_none());
    }
}
