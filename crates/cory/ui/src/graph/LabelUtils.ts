// ==============================================================================
// Label Resolution Utilities
// ==============================================================================
//
// Specialized logic for gathering and formatting labels from a GraphResponse.

import type { GraphResponse } from "../Types";
import { formatLabelEntry } from "../utils/Format";

export function resolveInputLabels(response: GraphResponse, txid: string, index: number): string[] {
  const inputRef = `${txid}:${index}`;
  const inputLabels = response.labels_by_type.input[inputRef] ?? [];
  const address = response.input_address_refs[inputRef] ?? null;
  const addrLabels = address ? (response.labels_by_type.addr[address] ?? []) : [];
  return [...addrLabels.map(formatLabelEntry), ...inputLabels.map(formatLabelEntry)];
}

export function resolveOutputLabels(response: GraphResponse, txid: string, index: number): string[] {
  const outputRef = `${txid}:${index}`;
  const outputLabels = response.labels_by_type.output[outputRef] ?? [];
  const address = response.output_address_refs[outputRef] ?? null;
  const addrLabels = address ? (response.labels_by_type.addr[address] ?? []) : [];
  return [...addrLabels.map(formatLabelEntry), ...outputLabels.map(formatLabelEntry)];
}

export function resolveTxLabels(response: GraphResponse, txid: string): string[] {
  return (response.labels_by_type.tx[txid] ?? []).map(formatLabelEntry);
}
