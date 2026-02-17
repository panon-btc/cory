// ==============================================================================
// Node Render Model Builder
// ==============================================================================
//
// Transforms raw GraphResponse data into the TxNodeData structures that
// txnode/Node.tsx renders. This module owns all the view-model interfaces
// and the logic for deciding which outputs to show vs. collapse.

import type { Node } from "@xyflow/react";
import type { GraphResponse } from "./types";
import {
  NODE_MIN_HEIGHT,
  NODE_BASE_HEIGHT,
  NODE_MIN_WIDTH,
  PRIMARY_ROW_HEIGHT,
  LABEL_LINE_HEIGHT,
  IO_COLUMNS_MIN_GUTTER,
  NODE_EXPAND_RAIL_GAP,
  NODE_EXPAND_RAIL_WIDTH,
} from "./constants";
import {
  shortTxid,
  shortOutpoint,
  shortAddress,
  formatSats,
  formatLabelEntry,
  buildTxMetaParts,
} from "./format";
import { measureTextWidth } from "./textMeasure";

// ==============================================================================
// View-Model Interfaces
// ==============================================================================

export interface TxInputView {
  index: number;
  prevout: string | null;
  address: string | null;
  labelLines: string[];
  rowHeight: number;
}

export interface TxOutputView {
  index: number;
  value: number;
  scriptType: string;
  connected: boolean;
  address: string | null;
  labelLines: string[];
  rowHeight: number;
}

export interface TxOutputGapView {
  kind: "gap";
  hiddenCount: number;
  rowHeight: number;
}

export interface TxOutputRowView extends TxOutputView {
  kind: "output";
}

export type TxOutputDisplayRow = TxOutputGapView | TxOutputRowView;

// Extends Record<string, unknown> to satisfy React Flow's Node<D> constraint,
// which requires an index signature that plain interfaces lack.
export interface TxNodeData extends Record<string, unknown> {
  txid: string;
  nodeWidth: number;
  inputColumnWidth: number;
  outputColumnWidth: number;
  blockHeight: number | null;
  feeSats: number | null;
  feerateSatVb: number | null;
  rbfSignaling: boolean;
  isCoinbase: boolean;
  txLabels: string[];
  inputRows: TxInputView[];
  outputRows: TxOutputDisplayRow[];
}

// ==============================================================================
// Height Estimation
// ==============================================================================

export function estimateNodeHeight(inputRowsHeight: number, outputRowsHeight: number): number {
  const rowsHeight = Math.max(inputRowsHeight, outputRowsHeight);
  return Math.max(NODE_MIN_HEIGHT, NODE_BASE_HEIGHT + rowsHeight);
}

let monoFamilyCache: string | undefined;

function monoFamily(): string {
  if (monoFamilyCache) return monoFamilyCache;
  if (typeof document !== "undefined") {
    const fromVar = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
    if (fromVar) {
      monoFamilyCache = fromVar;
      return monoFamilyCache;
    }
  }
  monoFamilyCache = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  return monoFamilyCache;
}

function measureTextPx(text: string, font: string): number {
  return Math.ceil(measureTextWidth(text, font));
}

export function estimateNodeWidths(
  txPreview: string,
  isCoinbase: boolean,
  blockHeight: number | null,
  feeSats: number | null,
  feerateSatVb: number | null,
  rbfSignaling: boolean,
  txLabels: string[],
  inputRows: TxInputView[],
  outputRows: TxOutputDisplayRow[],
): { nodeWidth: number; inputColumnWidth: number; outputColumnWidth: number } {
  const mono = monoFamily();
  const mainFont = `11px ${mono}`;
  const mainBoldFont = `600 11px ${mono}`;
  const smallFont = `9px ${mono}`;
  const smallItalicFont = `italic 9px ${mono}`;
  const titleFont = `600 12px ${mono}`;
  const metaFont = `10px ${mono}`;

  let inputColumnWidth = Math.ceil(measureTextPx("Inputs", metaFont));
  let outputColumnWidth = Math.ceil(measureTextPx("Outputs", metaFont));

  for (const row of inputRows) {
    // Use compact previews for sizing so long addresses/txids don't force
    // permanently wide nodes; rendering still uses full text + middle ellipsis.
    const primary = row.address ? shortAddress(row.address) : shortOutpoint(row.prevout);
    const primaryWidth = 24 + 6 + measureTextPx(primary, mainFont);
    inputColumnWidth = Math.max(inputColumnWidth, primaryWidth);

    for (const label of row.labelLines) {
      const labelWidth = 30 + measureTextPx(label, smallItalicFont);
      inputColumnWidth = Math.max(inputColumnWidth, labelWidth);
    }
  }

  for (const row of outputRows) {
    if (row.kind === "gap") {
      const gapText = `... ${row.hiddenCount} hidden ...`;
      outputColumnWidth = Math.max(outputColumnWidth, 24 + 6 + measureTextPx(gapText, metaFont));
      continue;
    }

    const primary = row.address ? shortAddress(row.address) : row.scriptType;
    const primaryWidth = 24 + 6 + measureTextPx(primary, row.connected ? mainBoldFont : mainFont);
    const valueWidth = 24 + 6 + measureTextPx(formatSats(row.value), smallFont);
    outputColumnWidth = Math.max(outputColumnWidth, primaryWidth, valueWidth);

    for (const label of row.labelLines) {
      const labelWidth = 24 + 6 + measureTextPx(label, smallItalicFont);
      outputColumnWidth = Math.max(outputColumnWidth, labelWidth);
    }
  }

  // Header rows span both columns. Ensure txid/meta/tx-label lines fit too.
  const metaItems = buildTxMetaParts({
    blockHeight,
    feeSats,
    feerateSatVb,
    rbfSignaling,
    isCoinbase,
  });

  const txLabelLine = txLabels.join(", ");
  const headerWidth = Math.max(
    24 + 6 + measureTextPx(txPreview, titleFont),
    measureTextPx(metaItems.join(" | "), metaFont),
    txLabelLine.length > 0 ? measureTextPx(txLabelLine, smallItalicFont) : 0,
  );

  const nodeWidth = Math.max(
    NODE_MIN_WIDTH,
    // The I/O section now includes an internal expand rail. Reserve that
    // width here so the input/output columns keep the same usable space.
    20 +
      NODE_EXPAND_RAIL_WIDTH +
      NODE_EXPAND_RAIL_GAP +
      inputColumnWidth +
      IO_COLUMNS_MIN_GUTTER +
      outputColumnWidth,
    // Header rows do not render the rail, but they still share the same
    // outer node width budget.
    20 + NODE_EXPAND_RAIL_WIDTH + NODE_EXPAND_RAIL_GAP + headerWidth,
  );
  return { nodeWidth, inputColumnWidth, outputColumnWidth };
}

// ==============================================================================
// Output Visibility
// ==============================================================================

// Fan-out transactions can have hundreds of outputs. Showing all of them
// would make nodes enormous and unusable. Instead we show:
// - first/last 3 outputs for boundary context (so the user can see the
//   beginning and end of the output list)
// - all connected outputs (spent by visible transactions in the graph)
// - one neighbor on each side of connected outputs (so the user can see
//   what's adjacent to the spending chain)
// Everything else is collapsed into "... N hidden ..." gap rows.
export function buildVisibleOutputIndices(
  outputCount: number,
  connectedIndices: Set<number>,
): number[] {
  const visible = new Set<number>();

  for (let i = 0; i < Math.min(3, outputCount); i += 1) {
    visible.add(i);
  }

  for (let i = Math.max(0, outputCount - 3); i < outputCount; i += 1) {
    visible.add(i);
  }

  for (const index of connectedIndices) {
    visible.add(index);
    if (index > 0) {
      visible.add(index - 1);
    }
    if (index + 1 < outputCount) {
      visible.add(index + 1);
    }
  }

  return [...visible].sort((a, b) => a - b);
}

// ==============================================================================
// Connected Output Tracking
// ==============================================================================

// Scan edges to find which outputs on each transaction are consumed by
// another visible node. Only edges where both endpoints are in the visible
// node set are relevant — the graph may be truncated.
export function buildConnectedOutputsByTx(
  response: GraphResponse,
  nodeIds: Set<string>,
): Map<string, Set<number>> {
  const connectedOutputsByTx = new Map<string, Set<number>>();
  for (const edge of response.edges) {
    if (!nodeIds.has(edge.funding_txid) || !nodeIds.has(edge.spending_txid)) {
      continue;
    }
    const existing = connectedOutputsByTx.get(edge.funding_txid) ?? new Set<number>();
    existing.add(edge.funding_vout);
    connectedOutputsByTx.set(edge.funding_txid, existing);
  }
  return connectedOutputsByTx;
}

// ==============================================================================
// Node Render Model Construction
// ==============================================================================

export function buildNodeRenderModel(
  response: GraphResponse,
  txid: string,
  connectedOutputsByTx: Map<string, Set<number>>,
): { data: TxNodeData; nodeHeight: number } {
  // 1) Gather transaction/enrichment context reused by all row builders.
  const nodeData = response.nodes[txid]!;
  const enrichment = response.enrichments[txid];
  const isCoinbase = nodeData.inputs.length === 1 && nodeData.inputs[0]?.prevout === null;

  // 2) Build input rows with merged input+address labels and dynamic row height.
  const inputRows: TxInputView[] = nodeData.inputs.map((input, index) => {
    const inputRef = `${txid}:${index}`;
    const inputLabels = response.labels_by_type.input[inputRef] ?? [];
    const address = response.input_address_refs[inputRef] ?? null;
    const addrLabels = address ? (response.labels_by_type.addr[address] ?? []) : [];
    const labelLines = [...addrLabels.map(formatLabelEntry), ...inputLabels.map(formatLabelEntry)];
    return {
      index,
      prevout: input.prevout,
      address,
      labelLines,
      rowHeight: PRIMARY_ROW_HEIGHT + labelLines.length * LABEL_LINE_HEIGHT,
    };
  });

  // 3) Build full output rows first; visibility/collapse is handled in a later pass.
  const connectedIndices = connectedOutputsByTx.get(txid) ?? new Set<number>();
  const allOutputRows: TxOutputRowView[] = nodeData.outputs.map((output, index) => {
    const outputRef = `${txid}:${index}`;
    const outputLabels = response.labels_by_type.output[outputRef] ?? [];
    const address = response.output_address_refs[outputRef] ?? null;
    const addrLabels = address ? (response.labels_by_type.addr[address] ?? []) : [];
    const labelLines = [...addrLabels.map(formatLabelEntry), ...outputLabels.map(formatLabelEntry)];

    return {
      kind: "output",
      index,
      value: output.value,
      scriptType: output.script_type,
      connected: connectedIndices.has(index),
      address,
      labelLines,
      rowHeight: PRIMARY_ROW_HEIGHT + labelLines.length * LABEL_LINE_HEIGHT,
    };
  });

  // 4) Collapse non-essential output ranges into explicit `gap` rows.
  const visibleOutputIndices = buildVisibleOutputIndices(allOutputRows.length, connectedIndices);
  const outputRows: TxOutputDisplayRow[] = [];
  let prevVisibleIndex = -1;
  for (const visibleIndex of visibleOutputIndices) {
    const hiddenCount = visibleIndex - prevVisibleIndex - 1;
    if (hiddenCount > 0) {
      outputRows.push({
        kind: "gap",
        hiddenCount,
        rowHeight: PRIMARY_ROW_HEIGHT,
      });
    }

    outputRows.push(allOutputRows[visibleIndex]!);
    prevVisibleIndex = visibleIndex;
  }

  // 5) Assemble header metadata and final node height for layout sizing.
  const txLabels = (response.labels_by_type.tx[txid] ?? []).map(formatLabelEntry);
  const inputTotalHeight = inputRows.reduce((sum, row) => sum + row.rowHeight, 0);
  const outputTotalHeight = outputRows.reduce((sum, row) => sum + row.rowHeight, 0);
  const { nodeWidth, inputColumnWidth, outputColumnWidth } = estimateNodeWidths(
    shortTxid(txid),
    isCoinbase,
    nodeData.block_height,
    enrichment?.fee_sats ?? null,
    enrichment?.feerate_sat_vb ?? null,
    enrichment?.rbf_signaling ?? false,
    txLabels,
    inputRows,
    outputRows,
  );

  const data: TxNodeData = {
    txid,
    nodeWidth,
    inputColumnWidth,
    outputColumnWidth,
    blockHeight: nodeData.block_height,
    feeSats: enrichment?.fee_sats ?? null,
    feerateSatVb: enrichment?.feerate_sat_vb ?? null,
    rbfSignaling: enrichment?.rbf_signaling ?? false,
    isCoinbase,
    txLabels,
    inputRows,
    outputRows,
  };

  return {
    data,
    nodeHeight: estimateNodeHeight(inputTotalHeight, outputTotalHeight),
  };
}

// ==============================================================================
// Node Refresh (Label Updates Without Re-Layout)
// ==============================================================================

// Recompute render models for existing nodes without running ELK layout.
// Used when labels change — the node positions stay the same, but the
// data and estimated heights are refreshed.
export function refreshNodesFromGraph(
  response: GraphResponse,
  nodes: Node<TxNodeData>[],
): Node<TxNodeData>[] {
  const nodeIds = new Set(Object.keys(response.nodes));
  const connectedOutputsByTx = buildConnectedOutputsByTx(response, nodeIds);

  return nodes.map((node) => {
    if (!nodeIds.has(node.id)) {
      return node;
    }

    const { data, nodeHeight } = buildNodeRenderModel(response, node.id, connectedOutputsByTx);

    return {
      ...node,
      data,
      style: {
        ...(node.style ?? {}),
        width: data.nodeWidth,
        height: nodeHeight,
      },
    };
  });
}
