//! BIP-329 label management for Cory.
//!
//! Provides in-memory label storage with three file kinds
//! (PersistentRw, PersistentRo, BrowserRw), JSONL serialisation,
//! and recursive directory loading.

mod jsonl;
mod pack;
mod store;
mod types;

pub use store::LabelStore;
pub use types::{Bip329Record, Bip329Type, LabelFile, LabelFileKind, LabelStoreError};
