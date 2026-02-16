//! Native JSON-RPC client for Bitcoin Core compatible endpoints.
//!
//! Implements [`BitcoinRpc`] over JSON-RPC using `reqwest`, with support for
//! HTTP transport, optional request rate limiting, single and batched calls,
//! basic auth, and an LRU block-height cache.

mod client;
mod connection;
mod parsing;
mod protocol;

pub use client::HttpRpcClient;
