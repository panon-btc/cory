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
) -> Result<HashMap<LabelKey, Bip329Record>, CoreError> {
    content
        .lines()
        .enumerate()
        .try_fold(HashMap::new(), |mut map, (line_num, line)| {
            let line = line.trim();
            if line.is_empty() {
                return Ok(map);
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
            Ok(map)
        })
}

/// Export a label map to sorted JSONL. Records are ordered by (type, ref)
/// for deterministic output.
pub(super) fn export_map_to_jsonl(map: &HashMap<LabelKey, Bip329Record>) -> String {
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort_by(|(k1, _), (k2, _)| k1.0.cmp(&k2.0).then_with(|| k1.1.cmp(&k2.1)));

    entries
        .into_iter()
        .map(|(_, record)| serde_json::to_string(record).expect("valid JSON"))
        .map(|line| format!("{line}\n"))
        .collect()
}

/// Normalize a human-readable file name into a stable, lowercase,
/// hyphen-separated identifier suitable for use as a file ID.
pub fn normalize_label_file_id(name: &str) -> String {
    // Preserve folder structure in IDs while still normalizing each segment.
    // This lets names like `exchanges/binance` round-trip as subfolders.
    name.split(['/', '\\'])
        .map(|segment| {
            segment
                .chars()
                .flat_map(|c| c.to_lowercase())
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect::<String>()
                .split('-')
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("-")
        })
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) struct ParsedLocalFileName {
    pub id: String,
    pub name: String,
}

pub(super) fn parse_local_file_name(raw: &str) -> Result<ParsedLocalFileName, LabelStoreError> {
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
