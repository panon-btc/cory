import type { TxInputView } from "../../layout";
import { copyToClipboard } from "../../format";
import { MiddleEllipsisText } from "./MiddleEllipsisText";

interface InputRowProps {
  row: TxInputView;
  txid: string;
  refCallback: (index: number, el: HTMLDivElement | null) => void;
  onCopied: (value: string) => void;
}

export function InputRow({ row, txid, refCallback, onCopied }: InputRowProps) {
  const copyValue = row.address ?? `${txid}:${row.index}`;

  return (
    <div
      ref={(el) => refCallback(row.index, el)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        width: "100%",
        minWidth: 0,
        minHeight: row.rowHeight,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0, width: "100%" }}>
        <button
          type="button"
          className="nodrag nopan"
          onClick={() => {
            void copyToClipboard(copyValue).then((copied) => {
              if (copied) {
                onCopied(copyValue);
              }
            });
          }}
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
        <MiddleEllipsisText
          text={row.address ?? row.prevout ?? "coinbase"}
          title={row.address ?? row.prevout ?? "coinbase"}
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--text)",
          }}
        />
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
