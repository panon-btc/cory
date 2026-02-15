//! BIP-329 label management for Cory.
//!
//! Provides in-memory label storage with optional disk persistence,
//! JSONL serialisation, and read-only pack file loading.

mod jsonl;
mod pack;
mod store;
mod types;

pub use jsonl::normalize_label_file_id;
pub use store::LabelStore;
pub use types::{Bip329Record, Bip329Type, LabelFile, LabelFileKind, LabelStoreError};
