import type { LabelEntry } from "./types";

// ==============================================================================
// Transaction ID Formatting
// ==============================================================================

// Truncate a 64-char hex txid to "first18…last18" for compact display
// in node headers. The 36-char threshold avoids truncating already-short
// identifiers (e.g. in test fixtures).
export function shortTxid(txid: string): string {
  if (txid.length <= 36) return txid;
  return txid.substring(0, 18) + "\u2026" + txid.substring(txid.length - 18);
}

// ==============================================================================
// Outpoint & Address Formatting
// ==============================================================================

// Shorten a prevout reference ("txid:vout") for display in input rows.
// Coinbase inputs have no prevout, so null maps to the literal "coinbase".
export function shortOutpoint(outpoint: string | null): string {
  if (!outpoint) {
    return "coinbase";
  }
  if (outpoint.length <= 20) {
    return outpoint;
  }
  return `${outpoint.slice(0, 12)}...${outpoint.slice(-6)}`;
}

// Shorten a Bitcoin address to "first6...last6" for compact display.
export function shortAddress(address: string): string {
  if (address.length <= 14) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

// ==============================================================================
// Value & Fee Formatting
// ==============================================================================

// Format a satoshi value with locale-aware thousand separators and a "sat" suffix.
export function formatSats(value: number): string {
  return `${value.toLocaleString("en-US")} sat`;
}

// Format a feerate, stripping unnecessary trailing zeros.
// e.g. 12.300 → "12.3", 1.000 → "1"
export function formatFeerate(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

// ==============================================================================
// Label Formatting
// ==============================================================================

// Render a label entry as "file_name:label" for display in node I/O rows.
export function formatLabelEntry(entry: LabelEntry): string {
  return `${entry.file_name}:${entry.label}`;
}

// ==============================================================================
// Clipboard
// ==============================================================================

// Copy text to the clipboard. Failures are silently ignored because clipboard
// access requires a user gesture and may be unavailable in older browsers.
export function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}
