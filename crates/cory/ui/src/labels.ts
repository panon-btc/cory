// ==============================================================================
// Label State Mutations (Pure Functions)
// ==============================================================================
//
// Immutable update helpers for the GraphResponse label state. These are
// pure functions so they can be used inside React setState updaters and
// are easy to test in isolation.

import type { Bip329Type, GraphResponse, LabelEntry, LabelsByType } from "./types";

// Map a BIP-329 label type to the corresponding bucket in LabelsByType.
// Returns null for types we don't store client-side (e.g. "pubkey", "xpub").
function labelBucket(
  labels: LabelsByType,
  labelType: Bip329Type,
): Record<string, LabelEntry[]> | null {
  if (labelType === "tx") return labels.tx;
  if (labelType === "input") return labels.input;
  if (labelType === "output") return labels.output;
  if (labelType === "addr") return labels.addr;
  return null;
}

// Insert or update a label in the graph state. If a label from the same
// file already exists for this ref, it is replaced; otherwise a new entry
// is appended. Returns a new GraphResponse with shallow-copied label maps.
export function upsertLabel(
  graph: GraphResponse,
  fileId: string,
  fileName: string,
  labelType: Bip329Type,
  refId: string,
  label: string,
): GraphResponse {
  const next = {
    ...graph,
    labels_by_type: {
      tx: { ...graph.labels_by_type.tx },
      input: { ...graph.labels_by_type.input },
      output: { ...graph.labels_by_type.output },
      addr: { ...graph.labels_by_type.addr },
    },
  };

  const bucket = labelBucket(next.labels_by_type, labelType);
  if (!bucket) {
    return graph;
  }

  const existing = [...(bucket[refId] ?? [])];
  const idx = existing.findIndex((entry) => entry.file_id === fileId);
  const row: LabelEntry = {
    file_id: fileId,
    file_name: fileName,
    file_kind: "local",
    editable: true,
    label,
  };
  if (idx >= 0) {
    existing[idx] = row;
  } else {
    existing.push(row);
  }
  bucket[refId] = existing;

  return next;
}

// Remove a label for a specific file from the graph state. Returns a new
// GraphResponse with the entry filtered out of the relevant bucket.
export function removeLabel(
  graph: GraphResponse,
  fileId: string,
  labelType: Bip329Type,
  refId: string,
): GraphResponse {
  const next = {
    ...graph,
    labels_by_type: {
      tx: { ...graph.labels_by_type.tx },
      input: { ...graph.labels_by_type.input },
      output: { ...graph.labels_by_type.output },
      addr: { ...graph.labels_by_type.addr },
    },
  };

  const bucket = labelBucket(next.labels_by_type, labelType);
  if (!bucket) {
    return graph;
  }

  const existing = bucket[refId] ?? [];
  bucket[refId] = existing.filter((entry) => entry.file_id !== fileId);
  return next;
}
