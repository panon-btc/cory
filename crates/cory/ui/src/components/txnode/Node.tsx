import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TxOutputDisplayRow, TxFlowNode } from "../../layout";
import {
  IO_START_TOP,
  PRIMARY_ROW_HEIGHT,
  IO_ROW_GAP,
  IO_COLUMNS_MIN_GUTTER,
} from "../../constants";
import { copyToClipboard, buildTxMetaParts } from "../../format";
import { InputRow } from "./InputRow";
import { OutputRow } from "./OutputRow";
import { MiddleEllipsisText } from "./MiddleEllipsisText";

// Two-pass handle positioning:
//
// Pass 1 (useMemo, estimated): prefix-sum of row heights gives approximate
// handle Y positions. These are available immediately on first render,
// preventing edge flicker when React Flow draws connections before the DOM
// is measured.
//
// Pass 2 (useLayoutEffect, measured): after the DOM renders, we read each
// row's actual offsetTop to correct for any discrepancy between estimated
// and real heights (e.g. from font rendering differences or collapsed
// output gaps). The measured values take priority in the Handle `top` prop.
export default memo(function TxNode({ data, selected }: NodeProps<TxFlowNode>) {
  const inputRowRefs = useRef(new Map<number, HTMLDivElement>());
  const outputRowRefs = useRef(new Map<number, HTMLDivElement>());
  const [measuredInputHandleTops, setMeasuredInputHandleTops] = useState<Record<number, number>>(
    {},
  );
  const [measuredOutputHandleTops, setMeasuredOutputHandleTops] = useState<Record<number, number>>(
    {},
  );

  // Compute node enriched header below TXID title
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

  const inputRowsHeight = useMemo(
    () => data.inputRows.reduce((sum, row) => sum + row.rowHeight, 0),
    [data.inputRows],
  );
  const outputRowsHeight = useMemo(
    () => data.outputRows.reduce((sum, row) => sum + row.rowHeight, 0),
    [data.outputRows],
  );
  const columnHeightDelta = Math.abs(inputRowsHeight - outputRowsHeight);
  const inputTopOffset = inputRowsHeight < outputRowsHeight ? columnHeightDelta / 2 : 0;
  const outputTopOffset = outputRowsHeight < inputRowsHeight ? columnHeightDelta / 2 : 0;

  // Compute handle positions with a single prefix-sum pass per side,
  // avoiding the O(n^2) repeated slice+reduce.
  const inputHandleTops = useMemo(() => {
    const tops: Record<number, number> = {};
    let offset = 0;
    for (const row of data.inputRows) {
      tops[row.index] = IO_START_TOP + inputTopOffset + offset + PRIMARY_ROW_HEIGHT / 2;
      offset += row.rowHeight;
    }
    return tops;
  }, [data.inputRows, inputTopOffset]);

  const outputHandleTops = useMemo(() => {
    const tops: Record<number, number> = {};
    let offset = 0;
    for (const row of data.outputRows) {
      if (row.kind === "output" && row.connected) {
        tops[row.index] = IO_START_TOP + outputTopOffset + offset + PRIMARY_ROW_HEIGHT / 2;
      }
      offset += row.rowHeight;
      if (row.kind === "gap") {
        // When collapsed ranges are shown as `...`, keep connected handles
        // visually aligned with subsequent rows by accounting for one extra
        // baseline row step in the compressed section.
        offset += PRIMARY_ROW_HEIGHT + IO_ROW_GAP;
      }
    }
    return tops;
  }, [data.outputRows, outputTopOffset]);

  // Measure rendered row positions so handle anchors align with the actual
  // DOM rows even when output lists are collapsed with gap placeholders.
  useLayoutEffect(() => {
    const nextInput: Record<number, number> = {};
    for (const row of data.inputRows) {
      const el = inputRowRefs.current.get(row.index);
      if (!el) continue;
      nextInput[row.index] = el.offsetTop + PRIMARY_ROW_HEIGHT / 2;
    }
    setMeasuredInputHandleTops(nextInput);

    const nextOutput: Record<number, number> = {};
    for (const row of data.outputRows) {
      if (row.kind !== "output" || !row.connected) continue;
      const el = outputRowRefs.current.get(row.index);
      if (!el) continue;
      nextOutput[row.index] = el.offsetTop + PRIMARY_ROW_HEIGHT / 2;
    }
    setMeasuredOutputHandleTops(nextOutput);
  }, [data.inputRows, data.outputRows]);

  const setInputRowRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      inputRowRefs.current.set(index, el);
    } else {
      inputRowRefs.current.delete(index);
    }
  }, []);

  const setOutputRowRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      outputRowRefs.current.set(index, el);
    } else {
      outputRowRefs.current.delete(index);
    }
  }, []);

  return (
    <div
      style={{
        background: "var(--surface-1)",
        border: `1.5px solid ${selected ? "var(--accent)" : "var(--border-subtle)"}`,
        borderRadius: 4,
        padding: "8px 10px",
        width: data.nodeWidth,
        fontFamily: "var(--mono)",
        fontSize: 11,
        boxShadow: selected
          ? "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent), 0 4px 14px color-mix(in srgb, var(--accent) 24%, transparent)"
          : undefined,
      }}
    >
      {data.inputRows.map((row, index) => (
        <Handle
          key={`in-${row.index}`}
          id={`in-${row.index}`}
          type="target"
          position={Position.Left}
          style={{
            top:
              measuredInputHandleTops[row.index] ??
              inputHandleTops[row.index] ??
              inputHandleTops[index],
            background: "transparent",
            border: "none",
            opacity: 0,
          }}
        />
      ))}

      {data.outputRows
        .filter(
          (row): row is Extract<TxOutputDisplayRow, { kind: "output" }> => row.kind === "output",
        )
        .filter((row) => row.connected)
        .map((row) => (
          <Handle
            key={`out-${row.index}`}
            id={`out-${row.index}`}
            type="source"
            position={Position.Right}
            style={{
              top: measuredOutputHandleTops[row.index] ?? outputHandleTops[row.index],
              background: "var(--border-strong)",
            }}
          />
        ))}

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          className="nodrag nopan"
          onClick={() => copyToClipboard(data.txid)}
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
          ⧉
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

      <div
        className="nodrag nopan"
        style={{
          marginTop: 8,
          display: "grid",
          gridTemplateColumns: `${data.inputColumnWidth}px minmax(${IO_COLUMNS_MIN_GUTTER}px, 1fr) ${data.outputColumnWidth}px`,
        }}
      >
        <div style={{ minWidth: 0, paddingTop: inputTopOffset }}>
          <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Inputs</div>
          <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
            {data.inputRows.map((row) => (
              <InputRow
                key={`input-row-${row.index}`}
                row={row}
                txid={data.txid}
                refCallback={setInputRowRef}
              />
            ))}
          </div>
        </div>

        <div style={{ minWidth: 0, paddingTop: outputTopOffset, gridColumn: 3 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Outputs</div>
          <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
            {data.outputRows.map((row, rowIndex) => (
              <OutputRow
                key={row.kind === "gap" ? `output-gap-${rowIndex}` : `output-row-${row.index}`}
                row={row}
                txid={data.txid}
                refCallback={setOutputRowRef}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
