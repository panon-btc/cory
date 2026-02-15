import type { TxOutputDisplayRow } from "../layout";
import { shortAddress, formatSats, copyToClipboard } from "../format";

interface TxNodeOutputRowProps {
  row: TxOutputDisplayRow;
  txid: string;
  refCallback: (index: number, el: HTMLDivElement | null) => void;
}

// Renders a single output row (address + value + labels) or a gap
// placeholder ("... N hidden ...") for collapsed output ranges.
export function TxNodeOutputRow({ row, txid, refCallback }: TxNodeOutputRowProps) {
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

  return (
    <div
      ref={(el) => refCallback(row.index, el)}
      style={{
        display: "flex",
        gap: 6,
        alignItems: "flex-start",
        minHeight: row.rowHeight,
      }}
    >
      <button
        type="button"
        className="nodrag nopan"
        onClick={() => copyToClipboard(row.address ?? `${txid}:${row.index}`)}
        title={
          row.address
            ? `Copy output address: ${row.address}`
            : `Copy output ref: ${txid}:${row.index}`
        }
        style={{
          color: "var(--accent)",
          minWidth: 24,
          border: "none",
          background: "transparent",
          padding: 0,
          textAlign: "left",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        #{row.index}
      </button>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <span
          style={{
            color: row.connected ? "var(--text)" : "var(--text-muted)",
            fontWeight: row.connected ? 600 : 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={
            row.address
              ? `${row.address} (${row.connected ? "connected" : "not connected"})`
              : row.connected
                ? "Connected in visible graph"
                : "Not connected in visible graph"
          }
        >
          {row.address ? shortAddress(row.address) : row.scriptType}
        </span>
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
          <span
            key={`output-${row.index}-label-${idx}`}
            style={{
              color: "var(--text-muted)",
              fontSize: 9,
              fontStyle: "italic",
              lineHeight: 1.1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={label}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
