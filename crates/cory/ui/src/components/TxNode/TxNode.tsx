// ==============================================================================
// Transaction Node Component
// ==============================================================================
//
// The core visualization unit for the Bitcoin ancestry graph. Renders a
// single transaction with its inputs (left) and outputs (right).
// Handles React Flow handles, layout measurement, and parent expansion.

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { TxOutputDisplayRow, TxFlowNode } from "../../graph/Layout";
import {
  IO_START_TOP,
  PRIMARY_ROW_HEIGHT,
  IO_ROW_GAP,
  IO_COLUMNS_MIN_GUTTER,
  NODE_EXPAND_RAIL_GAP,
  NODE_EXPAND_RAIL_WIDTH,
} from "../../Constants";

import { InputRow } from "./InputRow";
import { OutputRow } from "./OutputRow";
import { TxNodeHeader } from "./TxNodeHeader";
import { TxNodeExpandRail } from "./TxNodeExpandRail";
import { TxNodeCollapseRail } from "./TxNodeCollapseRail";

interface TxNodeProps extends NodeProps<TxFlowNode> {
  onCopied: (value: string) => void;
  onToggleExpand: (txid: string) => void;
  onCollapseNode: (txid: string) => void;
  isRoot: boolean;
  expandMode: "expand" | "collapse";
  toggleDisabled: boolean;
  toggleLoading: boolean;
}

const IO_GRID_COL_INPUTS = 3;
const IO_GRID_COL_OUTPUTS = 5;

function ioGridTemplateColumns(inputColumnWidth: number, outputColumnWidth: number): string {
  return `${NODE_EXPAND_RAIL_WIDTH}px ${NODE_EXPAND_RAIL_GAP}px ${inputColumnWidth}px minmax(${IO_COLUMNS_MIN_GUTTER}px, 1fr) ${outputColumnWidth}px ${NODE_EXPAND_RAIL_GAP}px ${NODE_EXPAND_RAIL_WIDTH}px`;
}

export default memo(function TxNode({
  data,
  selected,
  onCopied,
  onToggleExpand,
  onCollapseNode,
  isRoot,
  expandMode,
  toggleDisabled,
  toggleLoading,
}: TxNodeProps) {
  const inputRowRefs = useRef(new Map<number, HTMLDivElement>());
  const outputRowRefs = useRef(new Map<number, HTMLDivElement>());
  const [measuredInputHandleTops, setMeasuredInputHandleTops] = useState<Record<number, number>>(
    {},
  );
  const [measuredOutputHandleTops, setMeasuredOutputHandleTops] = useState<Record<number, number>>(
    {},
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

  // Compute estimated handle positions (Pass 1 - avoids flicker on mount).
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
        offset += PRIMARY_ROW_HEIGHT + IO_ROW_GAP;
      }
    }
    return tops;
  }, [data.outputRows, outputTopOffset]);

  // Measured handle positions (Pass 2 - correction for actual DOM heights).
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
    if (el) inputRowRefs.current.set(index, el);
    else inputRowRefs.current.delete(index);
  }, []);

  const setOutputRowRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) outputRowRefs.current.set(index, el);
    else outputRowRefs.current.delete(index);
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
      {/* React Flow Handles */}
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

      <TxNodeHeader data={data} onCopied={onCopied} />

      <div
        style={{
          marginTop: 8,
          display: "grid",
          gridTemplateColumns: ioGridTemplateColumns(data.inputColumnWidth, data.outputColumnWidth),
          alignItems: "start",
        }}
      >
        <TxNodeExpandRail
          txid={data.txid}
          expandMode={expandMode}
          toggleDisabled={toggleDisabled}
          toggleLoading={toggleLoading}
          onToggleExpand={onToggleExpand}
        />

        {/* Inputs Column */}
        <div style={{ minWidth: 0, paddingTop: inputTopOffset, gridColumn: IO_GRID_COL_INPUTS }}>
          <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Inputs</div>
          <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
            {data.inputRows.map((row) => (
              <InputRow
                key={`input-row-${row.index}`}
                row={row}
                txid={data.txid}
                refCallback={setInputRowRef}
                onCopied={onCopied}
              />
            ))}
          </div>
        </div>

        {/* Outputs Column */}
        <div style={{ minWidth: 0, paddingTop: outputTopOffset, gridColumn: IO_GRID_COL_OUTPUTS }}>
          <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Outputs</div>
          <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
            {data.outputRows.map((row, rowIndex) => (
              <OutputRow
                key={row.kind === "gap" ? `output-gap-${rowIndex}` : `output-row-${row.index}`}
                row={row}
                txid={data.txid}
                refCallback={setOutputRowRef}
                onCopied={onCopied}
              />
            ))}
          </div>
        </div>

        <TxNodeCollapseRail txid={data.txid} disabled={isRoot} onCollapseNode={onCollapseNode} />
      </div>
    </div>
  );
});
