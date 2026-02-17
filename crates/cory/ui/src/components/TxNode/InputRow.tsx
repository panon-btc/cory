import type { TxInputView } from "../../graph/Layout";
import { MiddleEllipsisText } from "./MiddleEllipsisText";
import { CopyButton } from "../Common/CopyButton";
import { LabelLine } from "../Common/LabelLine";

interface InputRowProps {
  row: TxInputView;
  txid: string;
  refCallback: (index: number, el: HTMLDivElement | null) => void;
  onCopied: (value: string) => void;
}

export function InputRow({ row, refCallback, onCopied }: InputRowProps) {
  const copyValue = row.address ?? row.prevout ?? "coinbase";

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
        <CopyButton value={copyValue} onCopied={onCopied}>
          #{row.index}
        </CopyButton>
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
        <LabelLine
          key={`input-${row.index}-label-${idx}`}
          label={label}
          style={{ marginLeft: 30 }}
        />
      ))}
    </div>
  );
}
