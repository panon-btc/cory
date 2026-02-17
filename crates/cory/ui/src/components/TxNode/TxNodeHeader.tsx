import { useMemo } from "react";
import { Copy } from "lucide-react";
import { buildTxMetaParts } from "../../utils/Format";
import { MiddleEllipsisText } from "./MiddleEllipsisText";
import type { TxNodeData } from "../../graph/RenderModel";
import { CopyButton } from "../Common/CopyButton";
import { LabelLine } from "../Common/LabelLine";

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
        <CopyButton
          value={data.txid}
          onCopied={onCopied}
          title={`Copy txid: ${data.txid}`}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 3,
            padding: "2px 4px",
          }}
        >
          <Copy size={12} strokeWidth={2} aria-hidden="true" />
        </CopyButton>
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
        <LabelLine label={data.txLabels.join(", ")} style={{ marginTop: 2 }} />
      )}

      <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>
        {meta.join(" | ")}
      </div>
    </>
  );
}
