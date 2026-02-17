import type { TxOutputDisplayRow } from "../../graph/Layout";
import { formatSats } from "../../utils/Format";
import { MiddleEllipsisText } from "./MiddleEllipsisText";
import { CopyButton } from "../Common/CopyButton";
import { LabelLine } from "../Common/LabelLine";

interface OutputRowProps {
  row: TxOutputDisplayRow;
  txid: string;
  refCallback: (index: number, el: HTMLDivElement | null) => void;
  onCopied: (value: string) => void;
}

export function OutputRow({ row, txid, refCallback, onCopied }: OutputRowProps) {
  if (row.kind === "gap") {
    return (
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          minHeight: row.rowHeight,
        }}
        title={`${row.hiddenCount} output${row.hiddenCount === 1 ? "" : "s"} hidden`}
      >
        <span style={{ color: "var(--text-muted)", minWidth: 24 }}>...</span>
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
          ... {row.hiddenCount} hidden ...
        </span>
      </div>
    );
  }

  const copyValue = row.address ?? `${txid}:${row.index}`;

  return (
    <div
      ref={(el) => refCallback(row.index, el)}
      style={{
        display: "flex",
        gap: 6,
        alignItems: "flex-start",
        width: "100%",
        minWidth: 0,
        minHeight: row.rowHeight,
      }}
    >
      <CopyButton value={copyValue} onCopied={onCopied}>
        #{row.index}
      </CopyButton>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
        }}
      >
        <MiddleEllipsisText
          text={row.address ?? row.scriptType}
          title={
            row.address
              ? `${row.address} (${row.connected ? "connected" : "not connected"})`
              : row.connected
                ? "Connected in visible graph"
                : "Not connected in visible graph"
          }
          style={{
            color: row.connected ? "var(--text)" : "var(--text-muted)",
            fontWeight: row.connected ? 600 : 400,
          }}
        />
        <span
          style={{
            color: "var(--text-muted)",
            fontSize: 9,
            lineHeight: 1.1,
          }}
        >
          {formatSats(row.value)}
        </span>
        {row.labelLines.map((label, idx) => (
          <LabelLine key={`output-${row.index}-label-${idx}`} label={label} />
        ))}
      </div>
    </div>
  );
}
