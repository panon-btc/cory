// ==============================================================================
// TxNode Header Component
// ==============================================================================
//
// Renders the transaction ID, copy button, labels, and metadata summary
// (block height, fees, flags) at the top of a transaction node.

import { useMemo } from "react";
import { Copy } from "lucide-react";
import { copyToClipboard, buildTxMetaParts } from "../../utils/Format";
import { MiddleEllipsisText } from "./MiddleEllipsisText";
import type { TxNodeData } from "../../graph/RenderModel";

interface TxNodeHeaderProps {
  data: TxNodeData;
  onCopied: (value: string) => void;
}

export function TxNodeHeader({ data, onCopied }: TxNodeHeaderProps) {
  const meta = useMemo(
    () =>
      buildTxMetaParts({
        blockHeight: data.blockHeight,
        feeSats: data.feeSats,
        feerateSatVb: data.feerateSatVb,
        rbfSignaling: data.rbfSignaling,
        isCoinbase: data.isCoinbase,
      }),
    [data.blockHeight, data.feeSats, data.feerateSatVb, data.rbfSignaling, data.isCoinbase],
  );

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          className="nodrag nopan"
          onClick={() => {
            void copyToClipboard(data.txid).then((copied) => {
              if (copied) {
                onCopied(data.txid);
              }
            });
          }}
          aria-label="Copy transaction ID"
          title={`Copy txid: ${data.txid}`}
          style={{
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-muted)",
            borderRadius: 3,
            fontSize: 10,
            lineHeight: 1,
            padding: "2px 4px",
            cursor: "pointer",
          }}
        >
          <Copy size={12} strokeWidth={2} aria-hidden="true" />
        </button>
        <MiddleEllipsisText
          text={data.txid}
          style={{
            minWidth: 0,
            flex: 1,
            color: "var(--accent)",
            fontWeight: 600,
            fontSize: 12,
          }}
        />
      </div>

      {data.txLabels.length > 0 && (
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 9,
            fontStyle: "italic",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={data.txLabels.join(", ")}
        >
          {data.txLabels.join(", ")}
        </div>
      )}

      <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>
        {meta.join(" | ")}
      </div>
    </>
  );
}
