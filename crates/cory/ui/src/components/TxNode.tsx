import { memo, useMemo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TxNodeData } from "../layout";

type TxNodeProps = NodeProps & { data: TxNodeData };

const IO_START_TOP = 78;
const PRIMARY_ROW_HEIGHT = 18;

function shortOutpoint(outpoint: string | null): string {
  if (!outpoint) {
    return "coinbase";
  }
  if (outpoint.length <= 20) {
    return outpoint;
  }
  return `${outpoint.slice(0, 12)}...${outpoint.slice(-6)}`;
}

function shortAddress(address: string): string {
  if (address.length <= 14) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function formatSats(value: number): string {
  return `${value.toLocaleString("en-US")} sat`;
}

function formatFeerate(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

export default memo(function TxNode({ data, selected }: TxNodeProps) {
  const meta = useMemo(() => {
    const items: string[] = [];
    items.push(
      data.blockHeight != null ? `${data.blockHeight}` : "unconfirmed",
    );
    if (data.feeSats != null) {
      const feeText =
        data.feerateSatVb != null
          ? `${data.feeSats} sat (${formatFeerate(data.feerateSatVb)} sat/vB)`
          : `${data.feeSats} sat`;
      items.push(feeText);
    } else if (data.feerateSatVb == null) {
      items.push("fee n/a");
    }
    if (data.rbfSignaling) items.push("RBF");
    if (data.isCoinbase) items.push("coinbase");
    return items;
  }, [data]);

  const inputHandleTops = data.inputRows.map((_, index) => {
    const topOffset = data.inputRows
      .slice(0, index)
      .reduce((sum, row) => sum + row.rowHeight, 0);
    return IO_START_TOP + topOffset + PRIMARY_ROW_HEIGHT / 2;
  });

  const outputHandleTops = data.outputRows.map((_, index) => {
    const topOffset = data.outputRows
      .slice(0, index)
      .reduce((sum, row) => sum + row.rowHeight, 0);
    return IO_START_TOP + topOffset + PRIMARY_ROW_HEIGHT / 2;
  });

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1.5px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 4,
        padding: "8px 10px",
        width: 360,
        fontFamily: "var(--mono)",
        fontSize: 11,
        boxShadow: selected ? "0 0 8px var(--accent)" : undefined,
      }}
    >
      {data.inputRows.map((row, index) => (
        <Handle
          key={`in-${row.index}`}
          id={`in-${row.index}`}
          type="target"
          position={Position.Left}
          style={{ top: inputHandleTops[index], background: "var(--border)" }}
        />
      ))}

      {data.outputRows.map((row, index) => (
        <Handle
          key={`out-${row.index}`}
          id={`out-${row.index}`}
          type="source"
          position={Position.Right}
          style={{ top: outputHandleTops[index], background: "var(--border)" }}
        />
      ))}

      <div
        title={data.txid}
        style={{
          color: "var(--accent)",
          fontWeight: 600,
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {data.shortTxid}
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

      <div
        className="nodrag nopan"
        style={{
          marginTop: 8,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Inputs</div>
          <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
            {data.inputRows.map((row) => (
              <div
                key={`input-row-${row.index}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  minHeight: row.rowHeight,
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ color: "var(--accent)", minWidth: 24 }}>
                    #{row.index}
                  </span>
                  <span
                    style={{
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.address
                      ? shortAddress(row.address)
                      : shortOutpoint(row.prevout)}
                  </span>
                </div>
                {row.labelLines.map((label, idx) => (
                  <div
                    key={`input-${row.index}-label-${idx}`}
                    style={{
                      marginLeft: 30,
                      color: "var(--text-muted)",
                      fontSize: 8,
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
            ))}
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
            Outputs
          </div>
          <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
            {data.outputRows.map((row) => (
              <div
                key={`output-row-${row.index}`}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "flex-start",
                  minHeight: row.rowHeight,
                }}
              >
                <span style={{ color: "var(--accent)", minWidth: 24 }}>
                  #{row.index}
                </span>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      color: row.connected
                        ? "var(--text)"
                        : "var(--text-muted)",
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
                      fontSize: 7,
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
                        fontSize: 8,
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
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
