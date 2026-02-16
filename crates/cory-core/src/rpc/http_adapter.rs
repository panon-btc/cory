//! Native JSON-RPC client for Bitcoin Core compatible endpoints.
//!
//! Implements [`BitcoinRpc`] over HTTP using `reqwest`, with support for
//! single and batched RPC calls, basic auth, and an LRU block-height cache.

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bitcoin::{Amount, BlockHash, OutPoint, ScriptBuf, Txid};
use futures::future::try_join_all;
use lru::LruCache;
use reqwest::header;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{debug, trace, warn};

use crate::enrich::classify_script;
use crate::error::{CoreError, RpcError};
use crate::types::{BlockHeight, TxInput, TxNode, TxOutput};

use super::types::ChainInfo;
use super::BitcoinRpc;

// ==============================================================================
// HttpRpcClient — native JSON-RPC client for Bitcoin Core compatible endpoints
// ==============================================================================

/// Maximum number of block-hash → height entries cached in memory.
const BLOCK_HEIGHT_CACHE_CAP: usize = 10_000;
/// Maximum number of JSON-RPC calls per batch chunk.
const BATCH_CHUNK_SIZE: usize = 10;

/// HTTP-based Bitcoin Core JSON-RPC client.
///
/// Supports both single and batched RPC calls. Maintains an LRU cache of
/// block-hash-to-height mappings to avoid redundant `getblockheader` calls
/// for confirmed transactions.
pub struct HttpRpcClient {
    client: reqwest::Client,
    url: String,
    auth: Option<(String, String)>,
    next_id: AtomicU64,
    /// Bounded LRU cache mapping confirmed block hashes to their height.
    /// Confirmed block heights are immutable, so entries never need
    /// invalidation, only eviction under memory pressure.
    block_height_cache: RwLock<LruCache<BlockHash, BlockHeight>>,
}

impl HttpRpcClient {
    /// Create a new client pointing at `url` with optional basic auth.
    pub fn new(url: &str, user: Option<&str>, pass: Option<&str>) -> Self {
        let auth = match (user, pass) {
            (Some(u), Some(p)) => Some((u.to_owned(), p.to_owned())),
            _ => None,
        };

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(32)
            .tcp_nodelay(true)
            .build()
            .expect("reqwest client builder uses valid static config");

        Self {
            client,
            url: url.to_owned(),
            auth,
            next_id: AtomicU64::new(initial_request_id()),
            block_height_cache: RwLock::new(LruCache::new(
                NonZeroUsize::new(BLOCK_HEIGHT_CACHE_CAP)
                    .expect("BLOCK_HEIGHT_CACHE_CAP is non-zero"),
            )),
        }
    }

    /// Atomically reserve `count` consecutive request IDs for batch calls.
    fn reserve_request_ids(&self, count: u64) -> u64 {
        self.next_id.fetch_add(count, Ordering::Relaxed)
    }

    async fn rpc_call(
        &self,
        method: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, CoreError> {
        let id = self.reserve_request_ids(1);
        debug!(
            rpc.id = id,
            rpc.method = method,
            rpc.params = params.len(),
            "rpc call"
        );
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };

        let mut builder = self
            .client
            .post(&self.url)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&req);
        if let Some((ref user, ref pass)) = self.auth {
            builder = builder.basic_auth(user, Some(pass));
        }

        let response = builder.send().await.map_err(RpcError::Transport)?;
        let status = response.status();

        let body = response.text().await.map_err(RpcError::Transport)?;
        debug!(rpc.id = id, rpc.method = method, %status, body_len = body.len(), "rpc response");
        trace!(rpc.id = id, rpc.method = method, body = %body, "rpc response body");

        let decoded: JsonRpcResponse = serde_json::from_str(&body).map_err(|e| {
            RpcError::InvalidResponse(format!("decode JSON-RPC response: {e}; body={body}"))
        })?;

        if let Some(err) = decoded.error {
            return Err(parse_jsonrpc_error(err));
        }

        Ok(decoded.result.unwrap_or(serde_json::Value::Null))
    }

    async fn rpc_batch(
        &self,
        calls: &[(String, Vec<serde_json::Value>)],
    ) -> Result<Vec<serde_json::Value>, CoreError> {
        let start_id = self.reserve_request_ids(calls.len() as u64);
        debug!(
            rpc.batch_start_id = start_id,
            rpc.batch_size = calls.len(),
            "rpc batch call"
        );
        let requests: Vec<JsonRpcRequestOwned> = calls
            .iter()
            .enumerate()
            .map(|(offset, (method, params))| JsonRpcRequestOwned {
                jsonrpc: "2.0",
                id: start_id + offset as u64,
                method: method.clone(),
                params: params.clone(),
            })
            .collect();

        let mut builder = self
            .client
            .post(&self.url)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&requests);
        if let Some((ref user, ref pass)) = self.auth {
            builder = builder.basic_auth(user, Some(pass));
        }

        let response = builder.send().await.map_err(RpcError::Transport)?;
        let status = response.status();

        let body = response.text().await.map_err(RpcError::Transport)?;
        debug!(
            rpc.batch_start_id = start_id,
            rpc.batch_size = calls.len(),
            %status,
            body_len = body.len(),
            "rpc batch response"
        );
        trace!(
            rpc.batch_start_id = start_id,
            rpc.batch_size = calls.len(),
            body = %body,
            "rpc batch response body"
        );

        let decoded: Vec<JsonRpcResponseOwned> = serde_json::from_str(&body).map_err(|e| {
            RpcError::InvalidResponse(format!("decode JSON-RPC batch response: {e}; body={body}"))
        })?;

        let mut by_id: HashMap<u64, JsonRpcResponseOwned> = HashMap::with_capacity(decoded.len());
        for item in decoded {
            let id = parse_batch_id(&item.id)?;
            by_id.insert(id, item);
        }

        let mut ordered = Vec::with_capacity(calls.len());
        for id in start_id..(start_id + calls.len() as u64) {
            let item = by_id.remove(&id).ok_or(RpcError::MissingBatchItem { id })?;

            if let Some(err) = item.error {
                return Err(parse_jsonrpc_error(err));
            }
            ordered.push(item.result.unwrap_or(serde_json::Value::Null));
        }

        Ok(ordered)
    }

    async fn rpc_batch_chunked(
        &self,
        calls: &[(String, Vec<serde_json::Value>)],
    ) -> Result<Vec<serde_json::Value>, CoreError> {
        if calls.is_empty() {
            return Ok(Vec::new());
        }

        // Keep each payload small enough for node/proxy limits while still
        // issuing chunks concurrently to avoid serial round-trip latency.
        let chunk_futures: Vec<_> = calls
            .chunks(BATCH_CHUNK_SIZE)
            .map(|chunk| self.rpc_batch(chunk))
            .collect();
        let chunked = try_join_all(chunk_futures).await?;
        Ok(chunked.into_iter().flatten().collect())
    }

    async fn parse_tx_node_from_raw(&self, raw: serde_json::Value) -> Result<TxNode, CoreError> {
        let txid = parse_txid(raw.get("txid"), "txid")?;
        let version = parse_integer_required::<i32, true>(raw.get("version"), "version")?;
        let locktime = parse_integer_required::<u32, false>(raw.get("locktime"), "locktime")?;
        let size = parse_integer_required::<u64, false>(raw.get("size"), "size")?;
        let vsize = parse_integer_required::<u64, false>(raw.get("vsize"), "vsize")?;
        let weight = parse_integer_required::<u64, false>(raw.get("weight"), "weight")?;
        let block_hash = parse_opt_block_hash(raw.get("blockhash"))?;
        let mut block_height =
            parse_integer_optional::<u32, false>(raw.get("blockheight")).map(BlockHeight);
        let confirmations = parse_integer_optional::<u64, false>(raw.get("confirmations"));

        if block_height.is_none() {
            if let Some(block_hash) = block_hash {
                if confirmations.unwrap_or(0) > 0 {
                    block_height = self.get_block_height(block_hash).await?;
                }
            }
        }

        let vin = raw
            .get("vin")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| CoreError::InvalidTxData("missing vin array".into()))?;
        let vout = raw
            .get("vout")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| CoreError::InvalidTxData("missing vout array".into()))?;

        let inputs = parse_vin(vin)?;
        let outputs = parse_vout(vout)?;

        Ok(TxNode {
            txid,
            version,
            locktime,
            size,
            vsize,
            weight,
            block_hash,
            block_height,
            inputs,
            outputs,
        })
    }

    async fn get_block_height(
        &self,
        block_hash: BlockHash,
    ) -> Result<Option<BlockHeight>, CoreError> {
        // The LRU cache requires a write lock for `get` (it updates recency),
        // but the lookup is fast so the write lock is acceptable.
        if let Some(height) = self
            .block_height_cache
            .write()
            .await
            .get(&block_hash)
            .copied()
        {
            return Ok(Some(height));
        }

        let raw = self
            .rpc_call(
                "getblockheader",
                vec![
                    serde_json::json!(block_hash.to_string()),
                    serde_json::json!(true),
                ],
            )
            .await?;
        let height = parse_integer_optional::<u32, false>(raw.get("height")).map(BlockHeight);
        if let Some(height) = height {
            self.block_height_cache
                .write()
                .await
                .put(block_hash, height);
        }
        Ok(height)
    }
}

#[async_trait]
impl BitcoinRpc for HttpRpcClient {
    async fn get_transaction(&self, txid: &Txid) -> Result<TxNode, CoreError> {
        let raw = self
            .rpc_call(
                "getrawtransaction",
                vec![serde_json::json!(txid.to_string()), serde_json::json!(1)],
            )
            .await?;
        self.parse_tx_node_from_raw(raw).await
    }

    async fn get_transactions(&self, txids: &[Txid]) -> Result<Vec<TxNode>, CoreError> {
        if txids.is_empty() {
            return Ok(Vec::new());
        }

        let calls: Vec<(String, Vec<serde_json::Value>)> = txids
            .iter()
            .map(|txid| {
                (
                    "getrawtransaction".to_owned(),
                    vec![serde_json::json!(txid.to_string()), serde_json::json!(1)],
                )
            })
            .collect();

        let raw_results = match self.rpc_batch_chunked(&calls).await {
            Ok(results) => results,
            Err(batch_error) => {
                warn!(
                    tx_count = txids.len(),
                    error = %batch_error,
                    "batch getrawtransaction failed; falling back to sequential requests"
                );

                let mut sequential = Vec::with_capacity(txids.len());
                for txid in txids {
                    sequential.push(self.get_transaction(txid).await?);
                }
                return Ok(sequential);
            }
        };

        let parse_futures: Vec<_> = raw_results
            .into_iter()
            .map(|raw| self.parse_tx_node_from_raw(raw))
            .collect();
        try_join_all(parse_futures).await
    }

    async fn get_tx_out(&self, txid: &Txid, vout: u32) -> Result<Option<TxOutput>, CoreError> {
        let raw = self
            .rpc_call(
                "gettxout",
                vec![
                    serde_json::json!(txid.to_string()),
                    serde_json::json!(vout),
                    serde_json::json!(true),
                ],
            )
            .await?;

        parse_gettxout_result(raw)
    }

    async fn get_tx_outs(
        &self,
        outpoints: &[OutPoint],
    ) -> Result<Vec<Option<TxOutput>>, CoreError> {
        if outpoints.is_empty() {
            return Ok(Vec::new());
        }

        let calls: Vec<(String, Vec<serde_json::Value>)> = outpoints
            .iter()
            .map(|outpoint| {
                (
                    "gettxout".to_owned(),
                    vec![
                        serde_json::json!(outpoint.txid.to_string()),
                        serde_json::json!(outpoint.vout),
                        serde_json::json!(true),
                    ],
                )
            })
            .collect();

        let raw_results = self.rpc_batch_chunked(&calls).await?;
        raw_results.into_iter().map(parse_gettxout_result).collect()
    }

    async fn get_blockchain_info(&self) -> Result<ChainInfo, CoreError> {
        let raw = self.rpc_call("getblockchaininfo", Vec::new()).await?;
        let info: ChainInfo = serde_json::from_value(raw).map_err(|e| {
            CoreError::InvalidTxData(format!("invalid getblockchaininfo result: {e}"))
        })?;
        Ok(info)
    }
}

// ==============================================================================
// JSON-RPC Protocol Types
// ==============================================================================

#[derive(Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: Vec<serde_json::Value>,
}

#[derive(Serialize)]
struct JsonRpcRequestOwned {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponseOwned {
    id: serde_json::Value,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct TxOutResponse {
    value: serde_json::Value,
    #[serde(rename = "scriptPubKey")]
    script_pubkey: serde_json::Value,
}

// ==============================================================================
// JSON-RPC Error Parsing
// ==============================================================================

/// Parse a JSON-RPC error value into a structured `CoreError`.
///
/// The JSON-RPC spec defines errors as `{"code": <int>, "message": <string>}`.
/// If the error value matches that shape, we produce a `ServerError`;
/// otherwise we fall back to `InvalidResponse` with the raw JSON.
fn parse_jsonrpc_error(err: serde_json::Value) -> CoreError {
    #[derive(Deserialize)]
    struct JsonRpcError {
        code: i64,
        message: String,
    }

    if let Ok(parsed) = serde_json::from_value::<JsonRpcError>(err.clone()) {
        CoreError::Rpc(RpcError::ServerError {
            code: parsed.code,
            message: parsed.message,
        })
    } else {
        CoreError::Rpc(RpcError::InvalidResponse(format!(
            "non-standard JSON-RPC error: {err}"
        )))
    }
}

// ==============================================================================
// Response Field Parsers
// ==============================================================================

fn parse_gettxout_result(raw: serde_json::Value) -> Result<Option<TxOutput>, CoreError> {
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

fn parse_txid(value: Option<&serde_json::Value>, field: &str) -> Result<Txid, CoreError> {
    let value = value
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidTxData(format!("missing {field}")))?;
    value
        .parse()
        .map_err(|e| CoreError::InvalidTxData(format!("invalid {field}: {e}")))
}

fn parse_opt_block_hash(value: Option<&serde_json::Value>) -> Result<Option<BlockHash>, CoreError> {
    match value.and_then(serde_json::Value::as_str) {
        None => Ok(None),
        Some(s) => s
            .parse()
            .map(Some)
            .map_err(|e| CoreError::InvalidTxData(format!("invalid blockhash: {e}"))),
    }
}

fn parse_integer_required<T, const SIGNED: bool>(
    value: Option<&serde_json::Value>,
    field: &str,
) -> Result<T, CoreError>
where
    T: TryFrom<i64> + TryFrom<u64>,
{
    parse_integer::<T, SIGNED, true>(value, field)?
        .ok_or_else(|| CoreError::InvalidTxData(format!("missing {field}")))
}

fn parse_integer_optional<T, const SIGNED: bool>(value: Option<&serde_json::Value>) -> Option<T>
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

fn parse_vin(vin: &[serde_json::Value]) -> Result<Vec<TxInput>, CoreError> {
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

fn parse_vout(vout: &[serde_json::Value]) -> Result<Vec<TxOutput>, CoreError> {
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
fn parse_btc_amount(value: &serde_json::Value) -> Result<Amount, CoreError> {
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

fn parse_batch_id(id: &serde_json::Value) -> Result<u64, CoreError> {
    if let Some(n) = id.as_u64() {
        return Ok(n);
    }

    if let Some(s) = id.as_str() {
        return s.parse::<u64>().map_err(|e| {
            RpcError::InvalidResponse(format!("invalid batch response id string: {e}")).into()
        });
    }

    Err(RpcError::InvalidResponse(format!("invalid batch response id: {id}")).into())
}

fn initial_request_id() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- parse_btc_amount tests -----------------------------------------------

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

    // -- parse_gettxout_result tests ------------------------------------------

    #[test]
    fn parse_gettxout_result_null() {
        let val = serde_json::Value::Null;
        let result = parse_gettxout_result(val).expect("should parse null");
        assert!(result.is_none());
    }

    // -- parse_batch_id tests -------------------------------------------------

    #[test]
    fn parse_batch_id_u64() {
        let val = serde_json::json!(42);
        assert_eq!(parse_batch_id(&val).expect("should parse"), 42);
    }

    #[test]
    fn parse_batch_id_string() {
        let val = serde_json::json!("123");
        assert_eq!(parse_batch_id(&val).expect("should parse"), 123);
    }

    #[test]
    fn parse_batch_id_invalid() {
        let val = serde_json::json!(true);
        assert!(parse_batch_id(&val).is_err());
    }
}
