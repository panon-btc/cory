use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;

// ==============================================================================
// BIP-329 Record Types
// ==============================================================================

/// The type of entity a BIP-329 label refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
///
/// Each record associates a label string with a typed reference (transaction,
/// address, pubkey, input, output, or xpub).
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
// Namespace
// ==============================================================================

/// A namespace controls where labels come from and whether they're editable.
///
/// Labels are resolved with deterministic precedence: local edits take
/// priority over user custom packs, which take priority over default packs.
/// The UI should show all matching labels, not silently drop conflicts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Namespace {
    /// Locally editable labels. The string identifies the session/wallet.
    Local(String),
    /// Read-only label pack loaded from a directory. The string is the
    /// relative path used as a namespace identifier.
    Pack(String),
}

impl std::fmt::Display for Namespace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(name) => write!(f, "local:{name}"),
            Self::Pack(name) => write!(f, "pack:{name}"),
        }
    }
}

/// Composite key for looking up labels: (type, ref_id).
type LabelKey = (Bip329Type, String);

// ==============================================================================
// Label Store
// ==============================================================================

/// Manages labels across multiple namespaces with deterministic precedence.
///
/// The store is an ordered list of namespaces (local first, then packs in
/// load order). When resolving labels for a given key, all matching labels
/// are returned in precedence order so the UI can display them all.
///
/// Callers that need shared async access should wrap this in
/// `Arc<RwLock<LabelStore>>`.
pub struct LabelStore {
    /// Ordered list of namespaces. The local namespace comes first (highest
    /// precedence), followed by packs in the order they were loaded.
    namespaces: Vec<(Namespace, HashMap<LabelKey, Bip329Record>)>,
    /// The namespace name used for the local editable labels.
    local_namespace_name: String,
}

impl LabelStore {
    /// Create a new store with an empty local namespace ready for editing.
    pub fn new(local_namespace_name: &str) -> Self {
        Self {
            namespaces: vec![(
                Namespace::Local(local_namespace_name.to_string()),
                HashMap::new(),
            )],
            local_namespace_name: local_namespace_name.to_string(),
        }
    }

    /// The `Namespace` value used for local edits.
    pub fn local_namespace(&self) -> Namespace {
        Namespace::Local(self.local_namespace_name.clone())
    }

    // ==========================================================================
    // Import / Export
    // ==========================================================================

    /// Parse BIP-329 JSONL content and insert records into the given namespace.
    /// If the namespace doesn't exist yet, it is appended (i.e. lowest
    /// precedence among existing namespaces).
    pub fn import_bip329(&mut self, content: &str, namespace: Namespace) -> Result<(), CoreError> {
        let map = self.get_or_create_namespace(namespace);
        parse_jsonl_records(content, map)?;
        Ok(())
    }

    /// Serialize all records in the local editable namespace to BIP-329 JSONL.
    pub fn export_local_bip329(&self) -> String {
        self.export_namespace(&self.local_namespace())
    }

    /// Serialize all records in a specific namespace to BIP-329 JSONL.
    /// The output includes a trailing newline for JSONL compatibility.
    pub fn export_namespace(&self, namespace: &Namespace) -> String {
        let mut lines = Vec::new();
        for (ns, map) in &self.namespaces {
            if ns == namespace {
                for record in map.values() {
                    // serde_json::to_string on a valid Bip329Record cannot fail.
                    lines.push(serde_json::to_string(record).expect("valid JSON"));
                }
                break;
            }
        }
        if lines.is_empty() {
            return String::new();
        }
        let mut result = lines.join("\n");
        result.push('\n');
        result
    }

    // ==========================================================================
    // Query
    // ==========================================================================

    /// Return all labels matching the given type and ref_id across all
    /// namespaces, ordered by precedence (local first, then packs).
    pub fn get_labels(
        &self,
        label_type: Bip329Type,
        ref_id: &str,
    ) -> Vec<(Namespace, Bip329Record)> {
        let key = (label_type, ref_id.to_string());
        let mut results = Vec::new();
        for (ns, map) in &self.namespaces {
            if let Some(record) = map.get(&key) {
                results.push((ns.clone(), record.clone()));
            }
        }
        results
    }

    /// Get all labels for a given ref_id across all types and namespaces.
    pub fn get_all_labels_for_ref(&self, ref_id: &str) -> Vec<(Namespace, Bip329Record)> {
        let mut results = Vec::new();
        for (ns, map) in &self.namespaces {
            for ((_, r), record) in map.iter() {
                if r == ref_id {
                    results.push((ns.clone(), record.clone()));
                }
            }
        }
        results
    }

    // ==========================================================================
    // Mutation (local namespace only)
    // ==========================================================================

    /// Upsert a label in the local editable namespace.
    pub fn set_label(&mut self, label_type: Bip329Type, ref_id: String, label: String) {
        let local_ns = self.local_namespace();
        let map = self.get_or_create_namespace(local_ns);
        let key = (label_type, ref_id.clone());
        map.insert(
            key,
            Bip329Record {
                label_type,
                ref_id,
                label,
                origin: None,
                spendable: None,
            },
        );
    }

    // ==========================================================================
    // Pack Loading
    // ==========================================================================

    /// Walk a directory tree and load each `.jsonl` file as a pack namespace.
    /// The namespace name is derived from the file's path relative to `dir`.
    pub fn load_pack_dir(&mut self, dir: &Path) -> Result<(), CoreError> {
        if !dir.is_dir() {
            return Err(CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("label pack directory not found: {}", dir.display()),
            )));
        }

        walk_pack_dir(dir, dir, &mut self.namespaces)
    }

    // ==========================================================================
    // Internal
    // ==========================================================================

    /// Find or create a namespace, returning a mutable reference to its map.
    fn get_or_create_namespace(
        &mut self,
        namespace: Namespace,
    ) -> &mut HashMap<LabelKey, Bip329Record> {
        let pos = self.namespaces.iter().position(|(ns, _)| *ns == namespace);
        match pos {
            Some(idx) => &mut self.namespaces[idx].1,
            None => {
                self.namespaces.push((namespace, HashMap::new()));
                let last = self.namespaces.len() - 1;
                &mut self.namespaces[last].1
            }
        }
    }
}

/// Parse JSONL content into a label map, skipping empty lines.
fn parse_jsonl_records(
    content: &str,
    map: &mut HashMap<LabelKey, Bip329Record>,
) -> Result<(), CoreError> {
    for (line_num, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let record: Bip329Record =
            serde_json::from_str(line).map_err(|e| CoreError::LabelParse {
                line: line_num + 1,
                message: e.to_string(),
            })?;
        let key = (record.label_type, record.ref_id.clone());
        map.insert(key, record);
    }
    Ok(())
}

/// Recursively walk a directory, loading `.jsonl` files as pack namespaces.
fn walk_pack_dir(
    base: &Path,
    current: &Path,
    namespaces: &mut Vec<(Namespace, HashMap<LabelKey, Bip329Record>)>,
) -> Result<(), CoreError> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_pack_dir(base, &path, namespaces)?;
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            let relative = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let namespace = Namespace::Pack(relative);
            let content = std::fs::read_to_string(&path)?;

            let mut map = HashMap::new();
            parse_jsonl_records(&content, &mut map)?;

            namespaces.push((namespace, map));
        }
    }
    Ok(())
}

// ==============================================================================
// Tests
// ==============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bip329_round_trip() {
        let records = vec![
            Bip329Record {
                label_type: Bip329Type::Tx,
                ref_id: "abc123".into(),
                label: "Payment to Alice".into(),
                origin: None,
                spendable: None,
            },
            Bip329Record {
                label_type: Bip329Type::Addr,
                ref_id: "bc1qtest".into(),
                label: "Cold storage".into(),
                origin: Some("m/84'/0'/0'/0/0".into()),
                spendable: Some(true),
            },
            Bip329Record {
                label_type: Bip329Type::Output,
                ref_id: "abc123:0".into(),
                label: "Change output".into(),
                origin: None,
                spendable: None,
            },
            Bip329Record {
                label_type: Bip329Type::Pubkey,
                ref_id: "02aabbcc".into(),
                label: "Hardware key".into(),
                origin: None,
                spendable: None,
            },
            Bip329Record {
                label_type: Bip329Type::Xpub,
                ref_id: "xpub6test".into(),
                label: "Main wallet".into(),
                origin: Some("m/84'/0'/0'".into()),
                spendable: None,
            },
            Bip329Record {
                label_type: Bip329Type::Input,
                ref_id: "abc123:1".into(),
                label: "Input from exchange".into(),
                origin: None,
                spendable: None,
            },
        ];

        // Serialize to JSONL.
        let jsonl: String = records
            .iter()
            .map(|r| serde_json::to_string(r).expect("valid JSON"))
            .collect::<Vec<_>>()
            .join("\n");

        // Re-parse via the label store.
        let mut store = LabelStore::new("test");
        store
            .import_bip329(&jsonl, Namespace::Local("test".into()))
            .expect("import should succeed");

        let exported = store.export_local_bip329();
        let mut reimported: Vec<Bip329Record> = exported
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid JSON"))
            .collect();

        // Sort both for comparison since HashMap ordering is nondeterministic.
        let mut original = records;
        original.sort_by_key(|r| (r.ref_id.clone(), r.label.clone()));
        reimported.sort_by_key(|r| (r.ref_id.clone(), r.label.clone()));

        assert_eq!(original.len(), reimported.len(), "record count mismatch");
        for (orig, re) in original.iter().zip(reimported.iter()) {
            assert_eq!(orig, re, "record mismatch");
        }
    }

    #[test]
    fn label_precedence() {
        let mut store = LabelStore::new("local");

        // Add a label in the local namespace.
        store.set_label(Bip329Type::Tx, "txid1".into(), "Local label".into());

        // Add a conflicting label in a pack namespace.
        let pack_jsonl = r#"{"type":"tx","ref":"txid1","label":"Pack label"}"#;
        store
            .import_bip329(pack_jsonl, Namespace::Pack("default.jsonl".into()))
            .expect("import pack");

        // Both labels should be returned, local first.
        let labels = store.get_labels(Bip329Type::Tx, "txid1");
        assert_eq!(
            labels.len(),
            2,
            "should have 2 labels from different namespaces"
        );
        assert_eq!(labels[0].0, Namespace::Local("local".into()));
        assert_eq!(labels[0].1.label, "Local label");
        assert_eq!(labels[1].0, Namespace::Pack("default.jsonl".into()));
        assert_eq!(labels[1].1.label, "Pack label");
    }

    #[test]
    fn set_label_only_affects_local() {
        let mut store = LabelStore::new("local");

        // Import a pack label.
        let pack_jsonl = r#"{"type":"tx","ref":"txid1","label":"Pack label"}"#;
        store
            .import_bip329(pack_jsonl, Namespace::Pack("pack.jsonl".into()))
            .expect("import pack");

        // Set a local label for the same key.
        store.set_label(Bip329Type::Tx, "txid1".into(), "My label".into());

        // The pack label should be unchanged.
        let labels = store.get_labels(Bip329Type::Tx, "txid1");
        assert_eq!(labels.len(), 2);

        // Export local: should only contain the local label.
        let local_export = store.export_local_bip329();
        let local_records: Vec<Bip329Record> = local_export
            .lines()
            .map(|l| serde_json::from_str(l).expect("valid JSON"))
            .collect();
        assert_eq!(local_records.len(), 1);
        assert_eq!(local_records[0].label, "My label");

        // Export pack: should only contain the pack label.
        let pack_export = store.export_namespace(&Namespace::Pack("pack.jsonl".into()));
        let pack_records: Vec<Bip329Record> = pack_export
            .lines()
            .map(|l| serde_json::from_str(l).expect("valid JSON"))
            .collect();
        assert_eq!(pack_records.len(), 1);
        assert_eq!(pack_records[0].label, "Pack label");
    }

    #[test]
    fn empty_lines_are_skipped() {
        let mut store = LabelStore::new("test");

        let content = r#"
{"type":"tx","ref":"txid1","label":"First"}

{"type":"tx","ref":"txid2","label":"Second"}
"#;
        store
            .import_bip329(content, Namespace::Local("test".into()))
            .expect("import with empty lines");

        let labels1 = store.get_labels(Bip329Type::Tx, "txid1");
        assert_eq!(labels1.len(), 1);
        let labels2 = store.get_labels(Bip329Type::Tx, "txid2");
        assert_eq!(labels2.len(), 1);
    }
}
