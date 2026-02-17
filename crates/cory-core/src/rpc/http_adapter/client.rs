use std::collections::HashMap;
use std::num::{NonZeroU32, NonZeroUsize};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bitcoin::{BlockHash, OutPoint, Txid};
use futures::future::try_join_all;
use governor::clock::DefaultClock;
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter};
use lru::LruCache;
use reqwest::header;
use tokio::sync::RwLock;
use tracing::{debug, trace, warn};

use crate::error::{CoreError, RpcError};
use crate::types::{BlockHeight, TxNode, TxOutput};

use super::super::types::ChainInfo;
use super::super::BitcoinRpc;
use super::connection::{parse_connection, resolve_auth};
use super::parsing::{
    parse_gettxout_result, parse_integer_optional, parse_integer_required, parse_opt_block_hash,
    parse_txid, parse_vin, parse_vout,
};
use super::protocol::{
    parse_batch_id, parse_jsonrpc_error, JsonRpcRequest, JsonRpcRequestOwned, JsonRpcResponse,
    JsonRpcResponseOwned,
};

/// Maximum number of block-hash → height entries cached in memory.
const BLOCK_HEIGHT_CACHE_CAP: usize = 10_000;

type DirectRateLimiter = RateLimiter<NotKeyed, InMemoryState, DefaultClock>;

/// Bitcoin Core JSON-RPC client over HTTP(S).
///
/// Supports both single and batched RPC calls. Maintains an LRU cache of
/// block-hash-to-height mappings to avoid redundant `getblockheader` calls
/// for confirmed transactions.
pub struct HttpRpcClient {
    client: reqwest::Client,
    url: String,
    auth: Option<(String, String)>,
    limiter: Option<DirectRateLimiter>,
    batch_chunk_size: usize,
    next_id: AtomicU64,
    /// Bounded LRU cache mapping confirmed block hashes to their height.
    /// Confirmed block heights are immutable, so entries never need
    /// invalidation, only eviction under memory pressure.
    block_height_cache: RwLock<LruCache<BlockHash, BlockHeight>>,
}

impl HttpRpcClient {
    /// Create a new client for an HTTP URL.
    ///
    /// `connection` accepts one of:
    /// - `http://...` or `https://...` for standard HTTP RPC
    ///
    /// Authentication precedence:
    /// 1. explicit `user` + `pass`
    /// 2. cookie file (`username:password`) from `cookie_file`
    /// 3. no auth
    ///
    /// If `requests_per_second` is set, calls are rate-limited per outbound
    /// HTTP request (batched calls count as one request).
    pub fn new(
        connection: &str,
        user: Option<&str>,
        pass: Option<&str>,
        cookie_file: Option<&Path>,
        requests_per_second: Option<u32>,
        batch_chunk_size: usize,
    ) -> Result<Self, CoreError> {
        if batch_chunk_size == 0 {
            return Err(CoreError::InvalidTxData(
                "rpc batch chunk size must be at least 1".to_owned(),
            ));
        }
        let auth = resolve_auth(user, pass, cookie_file)?;
        let url = parse_connection(connection)?;

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(32)
            .tcp_nodelay(true)
            .build()
            .expect("reqwest client builder uses valid static config");

        let limiter = match requests_per_second {
            None => None,
            Some(limit) => {
                let limit = NonZeroU32::new(limit).ok_or_else(|| {
                    CoreError::InvalidTxData("requests_per_second must be at least 1".to_owned())
                })?;
                Some(RateLimiter::direct(Quota::per_second(limit)))
            }
        };

        Ok(Self {
            client,
            url,
            auth,
            limiter,
            batch_chunk_size,
            next_id: AtomicU64::new(initial_request_id()),
            block_height_cache: RwLock::new(LruCache::new(
                NonZeroUsize::new(BLOCK_HEIGHT_CACHE_CAP)
                    .expect("BLOCK_HEIGHT_CACHE_CAP is non-zero"),
            )),
        })
    }

    /// Atomically reserve `count` consecutive request IDs for batch calls.
    fn reserve_request_ids(&self, count: u64) -> u64 {
        self.next_id.fetch_add(count, Ordering::Relaxed)
    }

    async fn wait_for_rate_limit(&self) {
        if let Some(limiter) = &self.limiter {
            limiter.until_ready().await;
        }
    }

    async fn rpc_call(
        &self,
        method: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, CoreError> {
        self.wait_for_rate_limit().await;
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
        self.wait_for_rate_limit().await;
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
            .chunks(self.batch_chunk_size)
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
            .await
            .map_err(|err| normalize_getrawtransaction_error(txid, err))?;
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

fn initial_request_id() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}

// ==============================================================================
// RPC Error Normalization
// ==============================================================================

/// Convert Bitcoin Core "missing tx" JSON-RPC responses into `TxNotFound`.
///
/// This keeps not-found semantics strongly typed for upstream HTTP mapping,
/// while preserving other RPC/transport failures as-is.
fn normalize_getrawtransaction_error(txid: &Txid, err: CoreError) -> CoreError {
    match err {
        CoreError::Rpc(RpcError::ServerError { code, message })
            if is_tx_not_found_server_error(code, &message) =>
        {
            CoreError::TxNotFound(*txid)
        }
        other => other,
    }
}

fn is_tx_not_found_server_error(code: i64, message: &str) -> bool {
    if code != -5 {
        return false;
    }

    let msg = message.to_ascii_lowercase();
    msg.contains("not found") || msg.contains("no such mempool or blockchain transaction")
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::hashes::Hash;

    fn txid_1() -> Txid {
        Txid::from_slice(&[1; 32]).expect("static txid bytes must parse")
    }

    #[test]
    fn normalize_getrawtransaction_not_found_maps_to_typed_error() {
        let txid = txid_1();
        let err = CoreError::Rpc(RpcError::ServerError {
            code: -5,
            message: "No such mempool or blockchain transaction".to_string(),
        });

        let mapped = normalize_getrawtransaction_error(&txid, err);
        assert!(matches!(mapped, CoreError::TxNotFound(found) if found == txid));
    }

    #[test]
    fn normalize_getrawtransaction_other_server_error_preserved() {
        let txid = txid_1();
        let err = CoreError::Rpc(RpcError::ServerError {
            code: -32603,
            message: "Internal error".to_string(),
        });

        let mapped = normalize_getrawtransaction_error(&txid, err);
        assert!(matches!(
            mapped,
            CoreError::Rpc(RpcError::ServerError { code: -32603, .. })
        ));
    }

    #[test]
    fn normalize_getrawtransaction_non_rpc_error_preserved() {
        let txid = txid_1();
        let err = CoreError::InvalidTxData("bad data".to_string());

        let mapped = normalize_getrawtransaction_error(&txid, err);
        assert!(matches!(mapped, CoreError::InvalidTxData(message) if message == "bad data"));
    }
}
