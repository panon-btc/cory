//! Pack file loading — recursively discovers and loads read-only
//! `.jsonl` label files from a directory tree.

use std::collections::HashSet;
use std::path::Path;

use crate::error::CoreError;

use super::jsonl::{normalize_label_file_id, parse_jsonl_records};
use super::types::{LabelFile, LabelFileKind};

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

    entries.into_iter().try_for_each(|entry| {
        let path = entry.path();
        if path.is_dir() {
            walk_pack_dir(base, &path, pack_files, seen_ids)?;
            return Ok(());
        }

        if path.extension().is_none_or(|ext| ext != "jsonl") {
            return Ok(());
        }

        load_single_pack_file(base, &path, pack_files, seen_ids)
    })
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
    let relative = path.strip_prefix(base).unwrap_or(path);
    let relative_no_ext = relative
        .with_extension("")
        .to_string_lossy()
        .replace('\\', "/");
    let file_name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("pack")
        .to_string();

    let content = std::fs::read_to_string(path)?;
    let labels = parse_jsonl_records(&content)?;

    let id_core = normalize_label_file_id(&relative_no_ext);
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
        id: file_id,
        name: file_name,
        kind: LabelFileKind::Pack,
        editable: false,
        labels,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_pack_file_id_preserves_folder_segments() {
        let unique = format!(
            "pack-id-test-{}-{}",
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
            .expect("write test pack file");

        let mut pack_files = Vec::new();
        let mut seen_ids = HashSet::new();
        walk_pack_dir(&base, &base, &mut pack_files, &mut seen_ids).expect("load pack dir");

        assert_eq!(pack_files.len(), 1);
        assert_eq!(pack_files[0].id, "pack:exchanges/binance");

        std::fs::remove_dir_all(&base).expect("cleanup test dir");
    }
}
