import type { TxInputView } from "../layout";
import { shortOutpoint, shortAddress, copyToClipboard } from "../format";

interface TxNodeInputRowProps {
  row: TxInputView;
  txid: string;
  refCallback: (index: number, el: HTMLDivElement | null) => void;
}

export function TxNodeInputRow({ row, txid, refCallback }: TxNodeInputRowProps) {
  return (
    <div
      ref={(el) => refCallback(row.index, el)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        minHeight: row.rowHeight,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="nodrag nopan"
          onClick={() => copyToClipboard(row.address ?? `${txid}:${row.index}`)}
          title={
            row.address
              ? `Copy input address: ${row.address}`
              : `Copy input ref: ${txid}:${row.index}`
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
        <span
          style={{
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {row.address ? shortAddress(row.address) : shortOutpoint(row.prevout)}
        </span>
      </div>
      {row.labelLines.map((label, idx) => (
        <div
          key={`input-${row.index}-label-${idx}`}
          style={{
            marginLeft: 30,
            color: "var(--text-muted)",
            fontSize: 9,
            fontStyle: "italic",
            lineHeight: 1.1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "100%",
          }}
          title={label}
        >
          {label}
        </div>
      ))}
    </div>
  );
}
