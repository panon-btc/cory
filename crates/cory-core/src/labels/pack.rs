//! Pack file loading — recursively discovers and loads read-only
//! `.jsonl` label files from a directory tree.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::CoreError;

use super::jsonl::{normalize_label_file_id, parse_jsonl_records};
use super::types::{LabelFile, LabelFileKind, LabelFileMeta};

/// Recursively walk a directory, loading `.jsonl` files as pack files.
pub(super) fn walk_pack_dir(
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

        load_single_pack_file(base, &path, pack_files, seen_ids)?;
    }
    Ok(())
}

/// Load a single `.jsonl` file as a read-only pack label file.
///
/// The file ID is derived from its path relative to `base`, prefixed
/// with `pack:`. Duplicate IDs are rejected.
fn load_single_pack_file(
    base: &Path,
    path: &Path,
    pack_files: &mut Vec<LabelFile>,
    seen_ids: &mut HashSet<String>,
) -> Result<(), CoreError> {
    let relative = path
        .strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let file_name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("pack")
        .to_string();

    let content = std::fs::read_to_string(path)?;
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
    Ok(())
}
