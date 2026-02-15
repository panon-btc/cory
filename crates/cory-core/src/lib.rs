//! Core library for **Cory** — a Bitcoin transaction ancestry explorer.
//!
//! This crate provides the domain types, graph-building logic, label
//! management, and RPC abstraction that the `cory` server binary builds on.
//! It is intentionally transport-agnostic: the [`rpc::BitcoinRpc`] trait
//! can be backed by HTTP JSON-RPC, a mock, or any future transport.

pub mod cache;
pub mod enrich;
pub mod error;
pub mod graph;
pub mod labels;
pub mod rpc;
pub mod types;

#[cfg(test)]
pub(crate) mod test_util;

pub use error::{CoreError, RpcError};
pub use types::{AncestryGraph, GraphLimits, TxNode};
