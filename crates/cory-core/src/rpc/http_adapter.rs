use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bitcoin::{Amount, BlockHash, OutPoint, ScriptBuf, Txid};
use reqwest::header;
use serde::{Deserialize, Serialize};
use tracing::{debug, trace};

use crate::error::CoreError;
use crate::types::{ChainInfo, RawInputInfo, RawOutputInfo, RawTxInfo, TxOutInfo};

use super::BitcoinRpc;

// ==============================================================================
// HttpRpcClient — native JSON-RPC client for Bitcoin Core compatible endpoints
// ==============================================================================
//

pub struct HttpRpcClient {
    client: reqwest::Client,
    url: String,
    auth: Option<(String, String)>,
    next_id: AtomicU64,
}

impl HttpRpcClient {
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
        }
    }

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

        let response = builder
            .send()
            .await
            .map_err(|e| CoreError::Rpc(format!("HTTP error: {e}")))?;
        let status = response.status();

        let body = response
            .text()
            .await
            .map_err(|e| CoreError::Rpc(format!("read response body: {e}")))?;
        debug!(rpc.id = id, rpc.method = method, %status, body_len = body.len(), "rpc response");
        trace!(rpc.id = id, rpc.method = method, body = %body, "rpc response body");

        let decoded: JsonRpcResponse = serde_json::from_str(&body)
            .map_err(|e| CoreError::Rpc(format!("decode JSON-RPC response: {e}; body={body}")))?;

        if let Some(err) = decoded.error {
            return Err(CoreError::Rpc(err.to_string()));
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

        let response = builder
            .send()
            .await
            .map_err(|e| CoreError::Rpc(format!("HTTP error: {e}")))?;
        let status = response.status();

        let body = response
            .text()
            .await
            .map_err(|e| CoreError::Rpc(format!("read batch response body: {e}")))?;
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
            CoreError::Rpc(format!("decode JSON-RPC batch response: {e}; body={body}"))
        })?;

        let mut by_id: HashMap<u64, JsonRpcResponseOwned> = HashMap::with_capacity(decoded.len());
        for item in decoded {
            let id = parse_batch_id(&item.id)?;
            by_id.insert(id, item);
        }

        let mut ordered = Vec::with_capacity(calls.len());
        for id in start_id..(start_id + calls.len() as u64) {
            let item = by_id
                .remove(&id)
                .ok_or_else(|| CoreError::Rpc(format!("missing JSON-RPC batch item id={id}")))?;

            if let Some(err) = item.error {
                return Err(CoreError::Rpc(err.to_string()));
            }
            ordered.push(item.result.unwrap_or(serde_json::Value::Null));
        }

        Ok(ordered)
    }
}

#[async_trait]
impl BitcoinRpc for HttpRpcClient {
    async fn get_transaction(&self, txid: &Txid) -> Result<RawTxInfo, CoreError> {
        let raw = self
            .rpc_call(
                "getrawtransaction",
                vec![serde_json::json!(txid.to_string()), serde_json::json!(1)],
            )
            .await?;

        let txid = parse_txid(raw.get("txid"), "txid")?;
        let version = parse_i32(raw.get("version"), "version")?;
        let locktime = parse_u32(raw.get("locktime"), "locktime")?;
        let size = parse_u64(raw.get("size"), "size")?;
        let vsize = parse_u64(raw.get("vsize"), "vsize")?;
        let weight = parse_u64(raw.get("weight"), "weight")?;
        let block_hash = parse_opt_block_hash(raw.get("blockhash"))?;
        let confirmations = parse_opt_u64(raw.get("confirmations"));
        let block_time = parse_opt_u64(raw.get("blocktime"));

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

        Ok(RawTxInfo {
            txid,
            version,
            locktime,
            size,
            vsize,
            weight,
            block_hash,
            block_height: None,
            block_time,
            confirmations,
            inputs,
            outputs,
        })
    }

    async fn get_tx_out(&self, txid: &Txid, vout: u32) -> Result<Option<TxOutInfo>, CoreError> {
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
    ) -> Result<Vec<Option<TxOutInfo>>, CoreError> {
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

        let raw_results = self.rpc_batch(&calls).await?;
        raw_results.into_iter().map(parse_gettxout_result).collect()
    }

    async fn get_blockchain_info(&self) -> Result<ChainInfo, CoreError> {
        #[derive(Deserialize)]
        struct BlockchainInfoMinimal {
            chain: String,
            blocks: u64,
            bestblockhash: BlockHash,
            pruned: bool,
        }

        let raw = self.rpc_call("getblockchaininfo", Vec::new()).await?;
        let info: BlockchainInfoMinimal = serde_json::from_value(raw).map_err(|e| {
            CoreError::InvalidTxData(format!("invalid getblockchaininfo result: {e}"))
        })?;

        Ok(ChainInfo {
            chain: info.chain,
            blocks: info.blocks,
            best_block_hash: info.bestblockhash,
            pruned: info.pruned,
        })
    }
}

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
    value: f64,
    #[serde(rename = "scriptPubKey")]
    script_pubkey: serde_json::Value,
    confirmations: u64,
    coinbase: bool,
}

fn parse_gettxout_result(raw: serde_json::Value) -> Result<Option<TxOutInfo>, CoreError> {
    if raw.is_null() {
        return Ok(None);
    }

    let response: TxOutResponse = serde_json::from_value(raw)
        .map_err(|e| CoreError::InvalidTxData(format!("invalid gettxout result: {e}")))?;

    let value = Amount::from_btc(response.value)
        .map_err(|e| CoreError::InvalidTxData(format!("invalid BTC amount: {e}")))?;
    let script_pub_key = parse_script_pubkey_from_json(&response.script_pubkey)?;

    Ok(Some(TxOutInfo {
        value,
        script_pub_key,
        confirmations: response.confirmations,
        coinbase: response.coinbase,
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

fn parse_u64(value: Option<&serde_json::Value>, field: &str) -> Result<u64, CoreError> {
    value
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| CoreError::InvalidTxData(format!("missing {field}")))
}

fn parse_u32(value: Option<&serde_json::Value>, field: &str) -> Result<u32, CoreError> {
    parse_u64(value, field).and_then(|n| {
        u32::try_from(n).map_err(|_| CoreError::InvalidTxData(format!("{field} out of range: {n}")))
    })
}

fn parse_i32(value: Option<&serde_json::Value>, field: &str) -> Result<i32, CoreError> {
    let n = value
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| CoreError::InvalidTxData(format!("missing {field}")))?;
    i32::try_from(n).map_err(|_| CoreError::InvalidTxData(format!("{field} out of range: {n}")))
}

fn parse_opt_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    value.and_then(serde_json::Value::as_u64)
}

fn parse_vin(vin: &[serde_json::Value]) -> Result<Vec<RawInputInfo>, CoreError> {
    vin.iter()
        .map(|input| {
            let sequence = parse_u32(input.get("sequence"), "sequence")?;
            let is_coinbase = input.get("coinbase").is_some();

            let prevout = if is_coinbase {
                None
            } else {
                let prev_txid = parse_txid(input.get("txid"), "vin.txid")?;
                let prev_vout = parse_u32(input.get("vout"), "vin.vout")?;
                Some(OutPoint::new(prev_txid, prev_vout))
            };

            let prevout_value = input
                .get("prevout")
                .and_then(|p| p.get("value"))
                .and_then(serde_json::Value::as_f64)
                .and_then(|btc| Amount::from_btc(btc).ok());

            let prevout_script = input
                .get("prevout")
                .and_then(|p| p.get("scriptPubKey"))
                .and_then(|s| s.get("hex"))
                .and_then(serde_json::Value::as_str)
                .and_then(|hex_str| script_from_hex(hex_str).ok());

            Ok(RawInputInfo {
                prevout,
                sequence,
                prevout_value,
                prevout_script,
            })
        })
        .collect()
}

fn parse_vout(vout: &[serde_json::Value]) -> Result<Vec<RawOutputInfo>, CoreError> {
    vout.iter()
        .map(|output| {
            let value_btc = output
                .get("value")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| CoreError::InvalidTxData("missing value in vout".into()))?;
            let value = Amount::from_btc(value_btc)
                .map_err(|e| CoreError::InvalidTxData(format!("invalid vout amount: {e}")))?;

            let n = parse_u32(output.get("n"), "vout.n")?;
            let script =
                parse_script_pubkey_from_json(output.get("scriptPubKey").ok_or_else(|| {
                    CoreError::InvalidTxData("missing scriptPubKey in vout".into())
                })?)?;

            Ok(RawOutputInfo {
                value,
                script_pub_key: script,
                n,
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

fn parse_batch_id(id: &serde_json::Value) -> Result<u64, CoreError> {
    if let Some(n) = id.as_u64() {
        return Ok(n);
    }

    if let Some(s) = id.as_str() {
        return s
            .parse::<u64>()
            .map_err(|e| CoreError::Rpc(format!("invalid batch response id string: {e}")));
    }

    Err(CoreError::Rpc(format!("invalid batch response id: {id}")))
}

fn initial_request_id() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}
