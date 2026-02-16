//! Directory walking — recursively discovers and loads `.jsonl` label
//! files from a directory tree, parameterized by label file kind.

use std::collections::HashSet;
use std::path::Path;

use crate::error::CoreError;

use super::jsonl::parse_jsonl_records;
use super::types::{LabelFile, LabelFileKind};

/// Recursively walk a directory, loading `.jsonl` files as label files
/// of the given `kind`. The caller provides a `base` path (the CLI arg
/// directory) and the set of IDs already seen across all three kinds so
/// cross-kind collisions are detected.
pub(super) fn walk_label_dir(
    base: &Path,
    current: &Path,
    kind: LabelFileKind,
    files: &mut Vec<LabelFile>,
    seen_ids: &mut HashSet<String>,
) -> Result<(), CoreError> {
    // Sort directory entries by path for deterministic load order across
    // platforms and filesystems.
    let mut entries: Vec<_> = std::fs::read_dir(current)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.path());

    entries.into_iter().try_for_each(|entry| {
        let path = entry.path();
        if path.is_dir() {
            walk_label_dir(base, &path, kind, files, seen_ids)?;
            return Ok(());
        }

        if path.extension().is_none_or(|ext| ext != "jsonl") {
            return Ok(());
        }

        load_single_label_file(base, &path, kind, files, seen_ids)
    })
}

/// Load a single `.jsonl` file. The file ID is derived from the path
/// relative to `base`, with the `.jsonl` extension stripped and `\`
/// normalized to `/`. Duplicate IDs (across any kind) are rejected.
fn load_single_label_file(
    base: &Path,
    path: &Path,
    kind: LabelFileKind,
    files: &mut Vec<LabelFile>,
    seen_ids: &mut HashSet<String>,
) -> Result<(), CoreError> {
    let relative = path.strip_prefix(base).unwrap_or(path);
    let id = relative
        .with_extension("")
        .to_string_lossy()
        .replace('\\', "/");

    if id.is_empty() {
        return Ok(());
    }

    if !seen_ids.insert(id.clone()) {
        return Err(CoreError::LabelParse {
            line: 0,
            message: format!("duplicate label file ID `{id}` from {}", path.display()),
        });
    }

    let content = std::fs::read_to_string(path)?;
    let labels = parse_jsonl_records(&content)?;

    let (editable, source_path) = match kind {
        LabelFileKind::PersistentRw => (true, Some(path.to_path_buf())),
        // PersistentRo don't have a source path, so that there's no way we can write to them
        LabelFileKind::PersistentRo => (false, None),
        // BrowserRw files are never loaded from disk via walk_label_dir,
        // but handle the variant for completeness.
        LabelFileKind::BrowserRw => (true, None),
    };

    files.push(LabelFile {
        id: id.clone(),
        name: id,
        kind,
        editable,
        source_path,
        labels,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_label_file_id_preserves_folder_segments() {
        let unique = format!(
            "label-id-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos()
        );
        let base = std::path::Path::new("tmp").join(unique);
        let nested = base.join("exchanges");
        let file = nested.join("binance.jsonl");
        std::fs::create_dir_all(&nested).expect("create nested test dir");
        std::fs::write(&file, r#"{"type":"tx","ref":"abc","label":"Binance"}"#)
            .expect("write test label file");

        let mut files = Vec::new();
        let mut seen_ids = HashSet::new();
        walk_label_dir(
            &base,
            &base,
            LabelFileKind::PersistentRo,
            &mut files,
            &mut seen_ids,
        )
        .expect("load label dir");

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "exchanges/binance");
        assert_eq!(files[0].name, "exchanges/binance");
        assert!(!files[0].editable);
        assert!(files[0].source_path.is_none());

        std::fs::remove_dir_all(&base).expect("cleanup test dir");
    }

    #[test]
    fn persistent_rw_sets_source_path() {
        let unique = format!(
            "rw-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos()
        );
        let base = std::path::Path::new("tmp").join(unique);
        let file = base.join("wallet.jsonl");
        std::fs::create_dir_all(&base).expect("create test dir");
        std::fs::write(&file, r#"{"type":"tx","ref":"abc","label":"Test"}"#)
            .expect("write test label file");

        let mut files = Vec::new();
        let mut seen_ids = HashSet::new();
        walk_label_dir(
            &base,
            &base,
            LabelFileKind::PersistentRw,
            &mut files,
            &mut seen_ids,
        )
        .expect("load label dir");

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "wallet");
        assert!(files[0].editable);
        assert!(files[0].source_path.is_some());

        std::fs::remove_dir_all(&base).expect("cleanup test dir");
    }
}
