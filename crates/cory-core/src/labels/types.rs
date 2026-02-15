//! BIP-329 record types, label file definitions, and store error definitions.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;

// ==============================================================================
// BIP-329 Record Types
// ==============================================================================

/// The type of entity a BIP-329 label refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bip329Type {
    Tx,
    Addr,
    Pubkey,
    Input,
    Output,
    Xpub,
}

impl std::fmt::Display for Bip329Type {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Tx => write!(f, "tx"),
            Self::Addr => write!(f, "addr"),
            Self::Pubkey => write!(f, "pubkey"),
            Self::Input => write!(f, "input"),
            Self::Output => write!(f, "output"),
            Self::Xpub => write!(f, "xpub"),
        }
    }
}

/// A single BIP-329 label record, as defined by the specification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bip329Record {
    #[serde(rename = "type")]
    pub label_type: Bip329Type,
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spendable: Option<bool>,
}

// ==============================================================================
// Label Files
// ==============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelFileKind {
    Local,
    Pack,
}

#[derive(Debug, thiserror::Error)]
pub enum LabelStoreError {
    #[error("label file name cannot be empty")]
    EmptyFileName,

    #[error("ref must not be empty")]
    EmptyRef,

    #[error("label must not be empty")]
    EmptyLabel,

    #[error("label file already exists: {0}")]
    DuplicateLocalFile(String),

    #[error("local label file not found: {0}")]
    LocalFileNotFound(String),

    #[error(transparent)]
    Core(#[from] CoreError),
}

/// Composite key for looking up labels: (type, ref_id).
pub(super) type LabelKey = (Bip329Type, String);

/// A loaded label file (local or pack).
pub struct LabelFile {
    pub id: String,
    pub name: String,
    pub kind: LabelFileKind,
    pub editable: bool,
    pub(super) labels: HashMap<LabelKey, Bip329Record>,
}

impl LabelFile {
    /// Number of label records currently contained in this file.
    pub fn record_count(&self) -> usize {
        self.labels.len()
    }
}
