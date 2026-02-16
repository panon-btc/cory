const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface ParsedLabelRow {
  lineNumber: number;
  type: string;
  ref: string;
  label: string;
  txidTarget: string | null;
}

function normalizeTxidTarget(type: string, ref: string): string | null {
  const normalizedType = type.trim();
  const trimmedRef = ref.trim();
  if (!trimmedRef) return null;

  if (normalizedType === "tx") {
    return TXID_PATTERN.test(trimmedRef) ? trimmedRef : null;
  }

  if (normalizedType === "input" || normalizedType === "output") {
    const stripped = trimmedRef.replace(/:\d+$/, "");
    return TXID_PATTERN.test(stripped) ? stripped : null;
  }

  return null;
}

interface RawRecord {
  type?: unknown;
  ref?: unknown;
  label?: unknown;
}

export function parseLabelFileJsonl(content: string): ParsedLabelRow[] {
  const rows: ParsedLabelRow[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    const line = rawLine?.trim() ?? "";
    if (!line) continue;

    let parsed: RawRecord;
    try {
      parsed = JSON.parse(line) as RawRecord;
    } catch {
      throw new Error(`Invalid JSON on line ${lineNumber}.`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid record on line ${lineNumber}: expected an object.`);
    }

    if (typeof parsed.type !== "string" || !parsed.type.trim()) {
      throw new Error(`Invalid record on line ${lineNumber}: missing string 'type'.`);
    }
    if (typeof parsed.ref !== "string" || !parsed.ref.trim()) {
      throw new Error(`Invalid record on line ${lineNumber}: missing string 'ref'.`);
    }
    if (typeof parsed.label !== "string") {
      throw new Error(`Invalid record on line ${lineNumber}: missing string 'label'.`);
    }

    rows.push({
      lineNumber,
      type: parsed.type.trim(),
      ref: parsed.ref.trim(),
      label: parsed.label,
      txidTarget: normalizeTxidTarget(parsed.type, parsed.ref),
    });
  }

  return rows;
}
