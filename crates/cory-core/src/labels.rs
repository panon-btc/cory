use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelFileMeta {
    pub id: String,
    pub name: String,
    pub kind: LabelFileKind,
    pub editable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelFileSummary {
    pub id: String,
    pub name: String,
    pub kind: LabelFileKind,
    pub editable: bool,
    pub record_count: usize,
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
type LabelKey = (Bip329Type, String);

struct LabelFile {
    meta: LabelFileMeta,
    labels: HashMap<LabelKey, Bip329Record>,
}

pub struct LabelStore {
    local_files: Vec<LabelFile>,
    pack_files: Vec<LabelFile>,
    /// When set, local label files are persisted as JSONL in this directory.
    label_dir: Option<PathBuf>,
}

impl Default for LabelStore {
    fn default() -> Self {
        Self::new()
    }
}

impl LabelStore {
    pub fn new() -> Self {
        Self {
            local_files: Vec::new(),
            pack_files: Vec::new(),
            label_dir: None,
        }
    }

    /// Creates a new label store with persistence. Existing JSONL files in
    /// `dir` are loaded as editable local label files. Subsequent mutations
    /// are flushed to disk automatically.
    pub fn with_persistence(dir: &Path) -> Result<Self, CoreError> {
        std::fs::create_dir_all(dir)?;

        let mut store = Self {
            local_files: Vec::new(),
            pack_files: Vec::new(),
            label_dir: Some(dir.to_path_buf()),
        };

        // Load existing JSONL files from the label directory.
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.path());

        for entry in entries {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "jsonl") {
                continue;
            }
            let file_name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("labels")
                .to_string();
            let id = normalize_label_file_id(&file_name);
            if id.is_empty() {
                continue;
            }

            let content = std::fs::read_to_string(&path)?;
            let mut labels = HashMap::new();
            parse_jsonl_records(&content, &mut labels)?;

            store.local_files.push(LabelFile {
                meta: LabelFileMeta {
                    id,
                    name: file_name,
                    kind: LabelFileKind::Local,
                    editable: true,
                },
                labels,
            });
        }

        Ok(store)
    }

    // ========================================================================
    // Local file lifecycle
    // ========================================================================

    pub fn list_local_files(&self) -> Vec<LabelFileSummary> {
        self.local_files
            .iter()
            .map(|file| LabelFileSummary {
                id: file.meta.id.clone(),
                name: file.meta.name.clone(),
                kind: file.meta.kind,
                editable: file.meta.editable,
                record_count: file.labels.len(),
            })
            .collect()
    }

    pub fn list_files(&self) -> Vec<LabelFileSummary> {
        self.local_files
            .iter()
            .chain(self.pack_files.iter())
            .map(|file| LabelFileSummary {
                id: file.meta.id.clone(),
                name: file.meta.name.clone(),
                kind: file.meta.kind,
                editable: file.meta.editable,
                record_count: file.labels.len(),
            })
            .collect()
    }

    pub fn get_local_file_summary(&self, file_id: &str) -> Option<LabelFileSummary> {
        self.find_local_file_by_id(file_id)
            .map(|file| LabelFileSummary {
                id: file.meta.id.clone(),
                name: file.meta.name.clone(),
                kind: file.meta.kind,
                editable: file.meta.editable,
                record_count: file.labels.len(),
            })
    }

    pub fn create_local_file(&mut self, name: &str) -> Result<LabelFileMeta, LabelStoreError> {
        let parsed = parse_local_file_name(name)?;
        if self.find_local_file_index_by_id(&parsed.id).is_some() {
            return Err(LabelStoreError::DuplicateLocalFile(parsed.id));
        }

        let meta = LabelFileMeta {
            id: parsed.id.clone(),
            name: parsed.name,
            kind: LabelFileKind::Local,
            editable: true,
        };
        self.local_files.push(LabelFile {
            meta: meta.clone(),
            labels: HashMap::new(),
        });
        self.flush_local_file(&parsed.id)?;
        Ok(meta)
    }

    pub fn import_local_file(
        &mut self,
        name: &str,
        content: &str,
    ) -> Result<LabelFileMeta, LabelStoreError> {
        let parsed = parse_local_file_name(name)?;
        if self.find_local_file_index_by_id(&parsed.id).is_some() {
            return Err(LabelStoreError::DuplicateLocalFile(parsed.id));
        }

        let mut labels = HashMap::new();
        parse_jsonl_records(content, &mut labels)?;

        let meta = LabelFileMeta {
            id: parsed.id.clone(),
            name: parsed.name,
            kind: LabelFileKind::Local,
            editable: true,
        };
        self.local_files.push(LabelFile {
            meta: meta.clone(),
            labels,
        });
        self.flush_local_file(&parsed.id)?;

        Ok(meta)
    }

    pub fn replace_local_file_content(
        &mut self,
        file_id: &str,
        content: &str,
    ) -> Result<(), LabelStoreError> {
        let idx = self
            .find_local_file_index_by_id(file_id)
            .ok_or_else(|| LabelStoreError::LocalFileNotFound(file_id.to_string()))?;

        let mut labels = HashMap::new();
        parse_jsonl_records(content, &mut labels)?;
        self.local_files[idx].labels = labels;
        self.flush_local_file(file_id)?;
        Ok(())
    }

    pub fn remove_local_file(&mut self, file_id: &str) -> Result<(), LabelStoreError> {
        let idx = self
            .find_local_file_index_by_id(file_id)
            .ok_or_else(|| LabelStoreError::LocalFileNotFound(file_id.to_string()))?;
        let name = self.local_files[idx].meta.name.clone();
        self.local_files.remove(idx);
        self.remove_local_file_on_disk(&name);
        Ok(())
    }

    // ========================================================================
    // Local file import/export and mutation
    // ========================================================================

    pub fn export_local_file(&self, file_id: &str) -> Result<String, LabelStoreError> {
        let file = self
            .find_local_file_by_id(file_id)
            .ok_or_else(|| LabelStoreError::LocalFileNotFound(file_id.to_string()))?;
        Ok(export_map_to_jsonl(&file.labels))
    }

    pub fn set_local_label(
        &mut self,
        file_id: &str,
        label_type: Bip329Type,
        ref_id: String,
        label: String,
    ) -> Result<(), LabelStoreError> {
        if ref_id.trim().is_empty() {
            return Err(LabelStoreError::EmptyRef);
        }
        if label.trim().is_empty() {
            return Err(LabelStoreError::EmptyLabel);
        }
        let idx = self
            .find_local_file_index_by_id(file_id)
            .ok_or_else(|| LabelStoreError::LocalFileNotFound(file_id.to_string()))?;
        let key = (label_type, ref_id.clone());
        self.local_files[idx].labels.insert(
            key,
            Bip329Record {
                label_type,
                ref_id,
                label,
                origin: None,
                spendable: None,
            },
        );
        self.flush_local_file(file_id)?;
        Ok(())
    }

    pub fn delete_local_label(
        &mut self,
        file_id: &str,
        label_type: Bip329Type,
        ref_id: &str,
    ) -> Result<(), LabelStoreError> {
        let idx = self
            .find_local_file_index_by_id(file_id)
            .ok_or_else(|| LabelStoreError::LocalFileNotFound(file_id.to_string()))?;
        let key = (label_type, ref_id.to_string());
        self.local_files[idx].labels.remove(&key);
        self.flush_local_file(file_id)?;
        Ok(())
    }

    // ========================================================================
    // Query
    // ========================================================================

    /// Returns labels for a specific `(type, ref)` in deterministic precedence
    /// order: local files first (creation order), then pack files (load order).
    pub fn get_all_labels_for(
        &self,
        label_type: Bip329Type,
        ref_id: &str,
    ) -> Vec<(LabelFileMeta, Bip329Record)> {
        let key = (label_type, ref_id.to_string());
        let mut results = Vec::new();

        for file in self.local_files.iter().chain(self.pack_files.iter()) {
            if let Some(record) = file.labels.get(&key) {
                results.push((file.meta.clone(), record.clone()));
            }
        }

        results
    }

    // ========================================================================
    // Pack loading
    // ========================================================================

    pub fn load_pack_dir(&mut self, dir: &Path) -> Result<(), CoreError> {
        if !dir.is_dir() {
            return Err(CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("label pack directory not found: {}", dir.display()),
            )));
        }

        // Track existing pack IDs to detect collisions.
        let mut seen_ids: HashSet<String> =
            self.pack_files.iter().map(|f| f.meta.id.clone()).collect();
        walk_pack_dir(dir, dir, &mut self.pack_files, &mut seen_ids)
    }

    // ========================================================================
    // Internal
    // ========================================================================

    fn find_local_file_index_by_id(&self, file_id: &str) -> Option<usize> {
        self.local_files.iter().position(|f| f.meta.id == file_id)
    }

    fn find_local_file_by_id(&self, file_id: &str) -> Option<&LabelFile> {
        self.local_files.iter().find(|f| f.meta.id == file_id)
    }

    /// Flush a local file to disk if persistence is enabled.
    fn flush_local_file(&self, file_id: &str) -> Result<(), LabelStoreError> {
        let Some(dir) = &self.label_dir else {
            return Ok(());
        };
        let file = self
            .find_local_file_by_id(file_id)
            .ok_or_else(|| LabelStoreError::LocalFileNotFound(file_id.to_string()))?;
        let content = export_map_to_jsonl(&file.labels);
        let path = dir.join(format!("{}.jsonl", file.meta.name));
        std::fs::write(&path, content).map_err(CoreError::Io)?;
        Ok(())
    }

    /// Remove a local file from disk if persistence is enabled.
    fn remove_local_file_on_disk(&self, name: &str) {
        if let Some(dir) = &self.label_dir {
            let path = dir.join(format!("{name}.jsonl"));
            let _ = std::fs::remove_file(path);
        }
    }
}

struct ParsedLocalFileName {
    id: String,
    name: String,
}

fn parse_local_file_name(raw: &str) -> Result<ParsedLocalFileName, LabelStoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(LabelStoreError::EmptyFileName);
    }

    let name = trimmed
        .strip_suffix(".jsonl")
        .unwrap_or(trimmed)
        .trim()
        .to_string();
    if name.is_empty() {
        return Err(LabelStoreError::EmptyFileName);
    }

    let id = normalize_label_file_id(&name);
    if id.is_empty() {
        return Err(LabelStoreError::EmptyFileName);
    }

    Ok(ParsedLocalFileName { id, name })
}

pub fn normalize_label_file_id(name: &str) -> String {
    name.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn export_map_to_jsonl(map: &HashMap<LabelKey, Bip329Record>) -> String {
    // Sort by (type, ref) for deterministic export order.
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort_by(|(k1, _), (k2, _)| {
        k1.0.to_string()
            .cmp(&k2.0.to_string())
            .then_with(|| k1.1.cmp(&k2.1))
    });

    let mut lines = Vec::new();
    for (_, record) in entries {
        lines.push(serde_json::to_string(record).expect("valid JSON"));
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut result = lines.join("\n");
    result.push('\n');
    result
}

/// Parse JSONL content into a label map, skipping empty lines.
/// Duplicate entries (same type+ref) are accepted but logged as warnings.
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
        if map.contains_key(&key) {
            tracing::warn!(
                line = line_num + 1,
                label_type = %record.label_type,
                ref_id = %record.ref_id,
                "duplicate JSONL entry overwrites previous value"
            );
        }
        map.insert(key, record);
    }
    Ok(())
}

/// Recursively walk a directory, loading `.jsonl` files as pack files.
fn walk_pack_dir(
    base: &Path,
    current: &Path,
    pack_files: &mut Vec<LabelFile>,
    seen_ids: &mut HashSet<String>,
) -> Result<(), CoreError> {
    // Sort directory entries by path for deterministic load order across
    // platforms and filesystems.
    let mut entries: Vec<_> = std::fs::read_dir(current)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.path());

    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            walk_pack_dir(base, &path, pack_files, seen_ids)?;
            continue;
        }

        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }

        let relative = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let file_name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("pack")
            .to_string();

        let content = std::fs::read_to_string(&path)?;
        let mut labels = HashMap::new();
        parse_jsonl_records(&content, &mut labels)?;

        let id_core = normalize_label_file_id(&relative);
        let file_id = if id_core.is_empty() {
            "pack".to_string()
        } else {
            format!("pack:{id_core}")
        };

        if !seen_ids.insert(file_id.clone()) {
            return Err(CoreError::LabelParse {
                line: 0,
                message: format!("duplicate pack file ID `{file_id}` from {}", path.display()),
            });
        }

        pack_files.push(LabelFile {
            meta: LabelFileMeta {
                id: file_id,
                name: file_name,
                kind: LabelFileKind::Pack,
                editable: false,
            },
            labels,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_file_id() {
        assert_eq!(normalize_label_file_id("My Wallet"), "my-wallet");
        assert_eq!(normalize_label_file_id("wallet.jsonl"), "wallet-jsonl");
    }

    #[test]
    fn local_file_lifecycle_and_export() {
        let mut store = LabelStore::new();
        let created = store
            .create_local_file("wallet-a")
            .expect("create local file should succeed");
        assert_eq!(created.id, "wallet-a");

        store
            .set_local_label(
                "wallet-a",
                Bip329Type::Tx,
                "txid1".to_string(),
                "Label 1".to_string(),
            )
            .expect("set local label should succeed");

        let exported = store
            .export_local_file("wallet-a")
            .expect("export should succeed");
        assert!(exported.contains("\"label\":\"Label 1\""));

        store
            .remove_local_file("wallet-a")
            .expect("delete local file should succeed");
        assert!(store.list_local_files().is_empty());
    }

    #[test]
    fn get_all_labels_preserves_local_then_pack_precedence() {
        let mut store = LabelStore::new();
        store
            .import_local_file(
                "wallet-a",
                r#"{"type":"tx","ref":"txid1","label":"Local label"}"#,
            )
            .expect("local import should succeed");

        let mut pack_labels = HashMap::new();
        parse_jsonl_records(
            r#"{"type":"tx","ref":"txid1","label":"Pack label"}"#,
            &mut pack_labels,
        )
        .expect("pack parse should succeed");

        store.pack_files.push(LabelFile {
            meta: LabelFileMeta {
                id: "pack:default".into(),
                name: "default".into(),
                kind: LabelFileKind::Pack,
                editable: false,
            },
            labels: pack_labels,
        });

        let labels = store.get_all_labels_for(Bip329Type::Tx, "txid1");
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].0.kind, LabelFileKind::Local);
        assert_eq!(labels[1].0.kind, LabelFileKind::Pack);
    }

    #[test]
    fn typed_lookup_ignores_other_label_types() {
        let mut store = LabelStore::new();
        let file = store.create_local_file("wallet").expect("create file");

        store
            .set_local_label(
                &file.id,
                Bip329Type::Tx,
                "abc".to_string(),
                "tx label".to_string(),
            )
            .expect("set tx label");
        store
            .set_local_label(
                &file.id,
                Bip329Type::Addr,
                "abc".to_string(),
                "addr label".to_string(),
            )
            .expect("set addr label");

        let tx_labels = store.get_all_labels_for(Bip329Type::Tx, "abc");
        assert_eq!(tx_labels.len(), 1);
        assert_eq!(tx_labels[0].1.label, "tx label");

        let addr_labels = store.get_all_labels_for(Bip329Type::Addr, "abc");
        assert_eq!(addr_labels.len(), 1);
        assert_eq!(addr_labels[0].1.label, "addr label");
    }
}
