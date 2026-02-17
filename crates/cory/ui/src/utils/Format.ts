import type { LabelEntry } from "../Types";
import { measureTextWidth } from "./TextMeasure";

// ==============================================================================
// Transaction ID Formatting
// ==============================================================================

interface TxMetaPartsInput {
  blockHeight: number | null;
  feeSats: number | null;
  feerateSatVb: number | null;
  rbfSignaling: boolean;
  isCoinbase: boolean;
}

// Truncate a 64-char hex txid to "first18…last18" for compact previews
// (currently used by width estimation). The 36-char threshold avoids
// truncating already-short identifiers (e.g. in test fixtures).
export function shortTxid(txid: string): string {
  if (txid.length <= 36) return txid;
  return txid.substring(0, 18) + "\u2026" + txid.substring(txid.length - 18);
}

// Middle-truncate only when needed, preserving both start and end.
// Example: "abcdef...vwxyz". If it already fits, returns input unchanged.
export function middleEllipsize(text: string, maxWidthPx: number, font: string): string {
  if (maxWidthPx <= 0 || text.length <= 1) return text;
  if (measureTextWidth(text, font) <= maxWidthPx) return text;

  const ellipsis = "...";
  if (measureTextWidth(ellipsis, font) >= maxWidthPx) return ellipsis;

  let lo = 1;
  let hi = text.length - 1;
  let best = ellipsis;

  while (lo <= hi) {
    const kept = Math.floor((lo + hi) / 2);
    const left = Math.ceil(kept / 2);
    const right = Math.floor(kept / 2);
    const candidate = `${text.slice(0, left)}${ellipsis}${text.slice(text.length - right)}`;

    if (measureTextWidth(candidate, font) <= maxWidthPx) {
      best = candidate;
      lo = kept + 1;
    } else {
      hi = kept - 1;
    }
  }

  return best;
}

// Build the "block | fee | flags" metadata parts shown under the txid.
// Kept shared so UI rendering and width estimation stay in sync.
export function buildTxMetaParts({
  blockHeight,
  feeSats,
  feerateSatVb,
  rbfSignaling,
  isCoinbase,
}: TxMetaPartsInput): string[] {
  const items: string[] = [];
  items.push(blockHeight != null ? `${blockHeight}` : "unconfirmed");
  if (feeSats != null) {
    const feeText =
      feerateSatVb != null
        ? `${feeSats} sat (${formatFeerate(feerateSatVb)} sat/vB)`
        : `${feeSats} sat`;
    items.push(feeText);
  } else if (feerateSatVb == null) {
    items.push("fee n/a");
  }
  if (rbfSignaling) items.push("RBF");
  if (isCoinbase) items.push("coinbase");
  return items;
}

// ==============================================================================
// Outpoint & Address Formatting
// ==============================================================================

// Shorten a prevout reference ("txid:vout") for compact previews.
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

// Shorten a Bitcoin address to "first6...last6" for compact previews.
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
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
