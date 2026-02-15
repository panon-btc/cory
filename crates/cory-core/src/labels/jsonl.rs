//! JSONL serialization and deserialization for BIP-329 label records.
//!
//! Handles parsing JSONL files into label maps, exporting label maps to
//! JSONL, and normalising file names into stable identifiers.

use std::collections::HashMap;

use crate::error::CoreError;

use super::types::{Bip329Record, LabelKey, LabelStoreError};

/// Parse JSONL content into a label map, skipping empty lines.
/// Duplicate entries (same type+ref) are accepted but logged as warnings.
pub(super) fn parse_jsonl_records(
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

/// Export a label map to sorted JSONL. Records are ordered by (type, ref)
/// for deterministic output.
pub(super) fn export_map_to_jsonl(map: &HashMap<LabelKey, Bip329Record>) -> String {
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort_by(|(k1, _), (k2, _)| k1.0.cmp(&k2.0).then_with(|| k1.1.cmp(&k2.1)));

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

/// Normalize a human-readable file name into a stable, lowercase,
/// hyphen-separated identifier suitable for use as a file ID.
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

pub(super) struct ParsedLocalFileName {
    pub id: String,
    pub name: String,
}

pub(super) fn parse_local_file_name(
    raw: &str,
) -> Result<ParsedLocalFileName, LabelStoreError> {
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
