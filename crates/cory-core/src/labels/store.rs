//! `LabelStore` — the central in-memory store for BIP-329 label data.
//!
//! Manages three kinds of label files:
//! - **PersistentRw** — on-disk labels loaded from `--labels-rw` dirs,
//!   editable and auto-flushed to disk on mutation.
//! - **PersistentRo** — on-disk labels loaded from `--labels-ro` dirs,
//!   read-only.
//! - **BrowserRw** — browser-only labels created/imported/exported via
//!   the UI, editable but ephemeral.
//!
//! Queries merge results across all loaded files with deterministic
//! precedence: PersistentRw → BrowserRw → PersistentRo.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::CoreError;

use super::jsonl::{export_map_to_jsonl, parse_jsonl_records, parse_local_file_name};
use super::pack::walk_label_dir;
use super::types::{Bip329Record, Bip329Type, LabelFile, LabelFileKind, LabelStoreError};

pub struct LabelStore {
    persistent_rw_files: Vec<LabelFile>,
    browser_rw_files: Vec<LabelFile>,
    persistent_ro_files: Vec<LabelFile>,
}

impl Default for LabelStore {
    fn default() -> Self {
        Self::new()
    }
}

impl LabelStore {
    pub fn new() -> Self {
        Self {
            persistent_rw_files: Vec::new(),
            browser_rw_files: Vec::new(),
            persistent_ro_files: Vec::new(),
        }
    }

    // ========================================================================
    // Directory loading
    // ========================================================================

    /// Load a `--labels-rw` directory. Files are editable and auto-flushed
    /// to their on-disk `source_path` on mutation.
    pub fn load_rw_dir(&mut self, dir: &Path) -> Result<(), CoreError> {
        if !dir.is_dir() {
            return Err(CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("labels-rw directory not found: {}", dir.display()),
            )));
        }

        let mut seen_ids = self.all_ids();
        walk_label_dir(
            dir,
            dir,
            LabelFileKind::PersistentRw,
            &mut self.persistent_rw_files,
            &mut seen_ids,
        )
    }

    /// Load a `--labels-ro` directory. Files are read-only in the UI.
    pub fn load_ro_dir(&mut self, dir: &Path) -> Result<(), CoreError> {
        if !dir.is_dir() {
            return Err(CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("labels-ro directory not found: {}", dir.display()),
            )));
        }

        let mut seen_ids = self.all_ids();
        walk_label_dir(
            dir,
            dir,
            LabelFileKind::PersistentRo,
            &mut self.persistent_ro_files,
            &mut seen_ids,
        )
    }

    // ========================================================================
    // Browser file lifecycle (create, import, remove, replace)
    // ========================================================================

    pub fn create_browser_file(&mut self, name: &str) -> Result<String, LabelStoreError> {
        let parsed = parse_local_file_name(name)?;
        if self.find_file_by_id(&parsed.id).is_some() {
            return Err(LabelStoreError::DuplicateFileId(parsed.id));
        }

        let file = LabelFile {
            id: parsed.id.clone(),
            name: parsed.name,
            kind: LabelFileKind::BrowserRw,
            editable: true,
            source_path: None,
            labels: HashMap::new(),
        };
        self.browser_rw_files.push(file);
        Ok(parsed.id)
    }

    pub fn import_browser_file(
        &mut self,
        name: &str,
        content: &str,
    ) -> Result<String, LabelStoreError> {
        let parsed = parse_local_file_name(name)?;
        if self.find_file_by_id(&parsed.id).is_some() {
            return Err(LabelStoreError::DuplicateFileId(parsed.id));
        }

        let labels = parse_jsonl_records(content)?;

        let file = LabelFile {
            id: parsed.id.clone(),
            name: parsed.name,
            kind: LabelFileKind::BrowserRw,
            editable: true,
            source_path: None,
            labels,
        };
        self.browser_rw_files.push(file);

        Ok(parsed.id)
    }

    pub fn replace_browser_file_content(
        &mut self,
        file_id: &str,
        content: &str,
    ) -> Result<(), LabelStoreError> {
        let file = self
            .find_file_mut(file_id)
            .ok_or_else(|| LabelStoreError::FileNotFound(file_id.to_string()))?;

        if file.kind != LabelFileKind::BrowserRw {
            return Err(LabelStoreError::NotBrowserFile(file_id.to_string()));
        }

        let labels = parse_jsonl_records(content)?;
        file.labels = labels;
        Ok(())
    }

    pub fn remove_browser_file(&mut self, file_id: &str) -> Result<(), LabelStoreError> {
        // Check if the file exists at all.
        let file = self
            .find_file_by_id(file_id)
            .ok_or_else(|| LabelStoreError::FileNotFound(file_id.to_string()))?;

        if file.kind != LabelFileKind::BrowserRw {
            return Err(LabelStoreError::NotBrowserFile(file_id.to_string()));
        }

        let idx = self
            .browser_rw_files
            .iter()
            .position(|f| f.id == file_id)
            .expect("file verified to exist above");
        self.browser_rw_files.remove(idx);
        Ok(())
    }

    // ========================================================================
    // Export (works on all kinds)
    // ========================================================================

    pub fn export_file(&self, file_id: &str) -> Result<String, LabelStoreError> {
        let file = self
            .find_file_by_id(file_id)
            .ok_or_else(|| LabelStoreError::FileNotFound(file_id.to_string()))?;
        Ok(export_map_to_jsonl(&file.labels))
    }

    // ========================================================================
    // Label mutation (PersistentRw + BrowserRw only)
    // ========================================================================

    pub fn set_label(
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

        let file = self
            .find_file_mut(file_id)
            .ok_or_else(|| LabelStoreError::FileNotFound(file_id.to_string()))?;

        if !file.editable {
            return Err(LabelStoreError::ReadOnlyFile(file_id.to_string()));
        }

        let key = (label_type, ref_id.clone());
        file.labels.insert(
            key,
            Bip329Record {
                label_type,
                ref_id,
                label,
                origin: None,
                spendable: None,
            },
        );

        // Auto-flush PersistentRw files to disk.
        self.flush_file(file_id)?;
        Ok(())
    }

    pub fn delete_label(
        &mut self,
        file_id: &str,
        label_type: Bip329Type,
        ref_id: &str,
    ) -> Result<(), LabelStoreError> {
        let file = self
            .find_file_mut(file_id)
            .ok_or_else(|| LabelStoreError::FileNotFound(file_id.to_string()))?;

        if !file.editable {
            return Err(LabelStoreError::ReadOnlyFile(file_id.to_string()));
        }

        let key = (label_type, ref_id.to_string());
        file.labels.remove(&key);

        self.flush_file(file_id)?;
        Ok(())
    }

    // ========================================================================
    // Query
    // ========================================================================

    pub fn list_files(&self) -> Vec<&LabelFile> {
        self.persistent_rw_files
            .iter()
            .chain(self.browser_rw_files.iter())
            .chain(self.persistent_ro_files.iter())
            .collect()
    }

    pub fn get_file(&self, file_id: &str) -> Option<&LabelFile> {
        self.find_file_by_id(file_id)
    }

    /// Returns labels for a specific `(type, ref)` in deterministic
    /// precedence order: PersistentRw → BrowserRw → PersistentRo.
    pub fn get_all_labels_for(
        &self,
        label_type: Bip329Type,
        ref_id: &str,
    ) -> Vec<(&LabelFile, &Bip329Record)> {
        let key = (label_type, ref_id.to_string());
        let mut results = Vec::new();

        for file in self
            .persistent_rw_files
            .iter()
            .chain(self.browser_rw_files.iter())
            .chain(self.persistent_ro_files.iter())
        {
            if let Some(record) = file.labels.get(&key) {
                results.push((file, record));
            }
        }

        results
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    /// Collect all IDs across the three vecs for uniqueness checks.
    fn all_ids(&self) -> HashSet<String> {
        self.persistent_rw_files
            .iter()
            .chain(self.browser_rw_files.iter())
            .chain(self.persistent_ro_files.iter())
            .map(|f| f.id.clone())
            .collect()
    }

    fn find_file_by_id(&self, file_id: &str) -> Option<&LabelFile> {
        self.persistent_rw_files
            .iter()
            .chain(self.browser_rw_files.iter())
            .chain(self.persistent_ro_files.iter())
            .find(|f| f.id == file_id)
    }

    fn find_file_mut(&mut self, file_id: &str) -> Option<&mut LabelFile> {
        self.persistent_rw_files
            .iter_mut()
            .chain(self.browser_rw_files.iter_mut())
            .chain(self.persistent_ro_files.iter_mut())
            .find(|f| f.id == file_id)
    }

    /// Flush a file to disk if it has a `source_path` (PersistentRw).
    /// BrowserRw and PersistentRo files are no-ops as they have source_path None
    fn flush_file(&self, file_id: &str) -> Result<(), LabelStoreError> {
        let file = self
            .find_file_by_id(file_id)
            .ok_or_else(|| LabelStoreError::FileNotFound(file_id.to_string()))?;

        let Some(path) = &file.source_path else {
            return Ok(());
        };

        let content = export_map_to_jsonl(&file.labels);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(CoreError::Io)?;
        }
        std::fs::write(path, content).map_err(CoreError::Io)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::labels::jsonl::normalize_label_file_id;

    #[test]
    fn normalize_file_id_minimal() {
        // The new normalization only strips .jsonl and normalizes backslashes.
        assert_eq!(normalize_label_file_id("My Wallet"), "My Wallet");
        assert_eq!(normalize_label_file_id("wallet.jsonl"), "wallet");
        assert_eq!(
            normalize_label_file_id("Exchanges/Binance Hot"),
            "Exchanges/Binance Hot"
        );
        assert_eq!(
            normalize_label_file_id("path\\to\\file.jsonl"),
            "path/to/file"
        );
    }

    #[test]
    fn browser_file_lifecycle_and_export() {
        let mut store = LabelStore::new();
        let created = store
            .create_browser_file("wallet-a")
            .expect("create browser file should succeed");
        assert_eq!(created, "wallet-a");

        store
            .set_label(
                "wallet-a",
                Bip329Type::Tx,
                "txid1".to_string(),
                "Label 1".to_string(),
            )
            .expect("set label should succeed");

        let exported = store
            .export_file("wallet-a")
            .expect("export should succeed");
        assert!(exported.contains("\"label\":\"Label 1\""));

        store
            .remove_browser_file("wallet-a")
            .expect("delete browser file should succeed");
        assert!(
            store
                .list_files()
                .into_iter()
                .filter(|f| f.kind == LabelFileKind::BrowserRw)
                .count()
                == 0
        );
    }

    #[test]
    fn three_way_resolution_order() {
        let mut store = LabelStore::new();

        // Create a BrowserRw file with a label.
        store
            .import_browser_file(
                "browser-file",
                r#"{"type":"tx","ref":"txid1","label":"Browser label"}"#,
            )
            .expect("browser import should succeed");

        // Inject a PersistentRw file directly (simulating disk load).
        let rw_labels =
            parse_jsonl_records(r#"{"type":"tx","ref":"txid1","label":"PersistentRw label"}"#)
                .expect("rw parse should succeed");
        store.persistent_rw_files.push(LabelFile {
            id: "rw-file".into(),
            name: "rw-file".into(),
            kind: LabelFileKind::PersistentRw,
            editable: true,
            source_path: None,
            labels: rw_labels,
        });

        // Inject a PersistentRo file directly.
        let ro_labels =
            parse_jsonl_records(r#"{"type":"tx","ref":"txid1","label":"PersistentRo label"}"#)
                .expect("ro parse should succeed");
        store.persistent_ro_files.push(LabelFile {
            id: "ro-file".into(),
            name: "ro-file".into(),
            kind: LabelFileKind::PersistentRo,
            editable: false,
            source_path: None,
            labels: ro_labels,
        });

        let labels = store.get_all_labels_for(Bip329Type::Tx, "txid1");
        assert_eq!(labels.len(), 3);
        assert_eq!(labels[0].0.kind, LabelFileKind::PersistentRw);
        assert_eq!(labels[1].0.kind, LabelFileKind::BrowserRw);
        assert_eq!(labels[2].0.kind, LabelFileKind::PersistentRo);
    }

    #[test]
    fn typed_lookup_ignores_other_label_types() {
        let mut store = LabelStore::new();
        let file_id = store.create_browser_file("wallet").expect("create file");

        store
            .set_label(
                &file_id,
                Bip329Type::Tx,
                "abc".to_string(),
                "tx label".to_string(),
            )
            .expect("set tx label");
        store
            .set_label(
                &file_id,
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

    #[test]
    fn set_label_on_persistent_ro_returns_error() {
        let mut store = LabelStore::new();

        let ro_labels =
            parse_jsonl_records(r#"{"type":"tx","ref":"txid1","label":"Read-only label"}"#)
                .expect("ro parse should succeed");
        store.persistent_ro_files.push(LabelFile {
            id: "ro-file".into(),
            name: "ro-file".into(),
            kind: LabelFileKind::PersistentRo,
            editable: false,
            source_path: None,
            labels: ro_labels,
        });

        let result = store.set_label(
            "ro-file",
            Bip329Type::Tx,
            "txid1".to_string(),
            "new label".to_string(),
        );
        assert!(matches!(result, Err(LabelStoreError::ReadOnlyFile(_))));
    }

    #[test]
    fn remove_persistent_rw_file_returns_not_browser_file() {
        let mut store = LabelStore::new();

        store.persistent_rw_files.push(LabelFile {
            id: "rw-file".into(),
            name: "rw-file".into(),
            kind: LabelFileKind::PersistentRw,
            editable: true,
            source_path: None,
            labels: HashMap::new(),
        });

        let result = store.remove_browser_file("rw-file");
        assert!(matches!(result, Err(LabelStoreError::NotBrowserFile(_))));
    }

    // -- error cases ----------------------------------------------------------

    #[test]
    fn create_file_with_empty_name_fails() {
        let mut store = LabelStore::new();
        assert!(matches!(
            store.create_browser_file(""),
            Err(LabelStoreError::EmptyFileName)
        ));
    }

    #[test]
    fn create_duplicate_file_fails() {
        let mut store = LabelStore::new();
        store.create_browser_file("wallet").expect("first create");
        assert!(matches!(
            store.create_browser_file("wallet"),
            Err(LabelStoreError::DuplicateFileId(_))
        ));
    }

    #[test]
    fn set_label_with_empty_ref_fails() {
        let mut store = LabelStore::new();
        store.create_browser_file("wallet").expect("create");
        assert!(matches!(
            store.set_label(
                "wallet",
                Bip329Type::Tx,
                "  ".to_string(),
                "label".to_string()
            ),
            Err(LabelStoreError::EmptyRef)
        ));
    }

    #[test]
    fn set_label_with_empty_label_fails() {
        let mut store = LabelStore::new();
        store.create_browser_file("wallet").expect("create");
        assert!(matches!(
            store.set_label(
                "wallet",
                Bip329Type::Tx,
                "txid1".to_string(),
                "  ".to_string()
            ),
            Err(LabelStoreError::EmptyLabel)
        ));
    }

    #[test]
    fn remove_nonexistent_file_fails() {
        let mut store = LabelStore::new();
        assert!(matches!(
            store.remove_browser_file("no-such-file"),
            Err(LabelStoreError::FileNotFound(_))
        ));
    }

    #[test]
    fn export_nonexistent_file_fails() {
        let store = LabelStore::new();
        assert!(matches!(
            store.export_file("no-such-file"),
            Err(LabelStoreError::FileNotFound(_))
        ));
    }
}
