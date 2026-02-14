// ==============================================================================
// Node Render Model Builder
// ==============================================================================
//
// Transforms raw GraphResponse data into the TxNodeData structures that
// TxNode.tsx renders. This module owns all the view-model interfaces and
// the logic for deciding which outputs to show vs. collapse.

import type { Node } from "@xyflow/react";
import type { GraphResponse } from "./types";
import {
  NODE_MIN_HEIGHT,
  NODE_BASE_HEIGHT,
  PRIMARY_ROW_HEIGHT,
  LABEL_LINE_HEIGHT,
} from "./constants";
import { shortTxid, formatLabelEntry } from "./format";

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

export interface TxNodeData {
  txid: string;
  shortTxid: string;
  blockHeight: number | null;
  feeSats: number | null;
  feerateSatVb: number | null;
  rbfSignaling: boolean;
  isCoinbase: boolean;
  txLabels: string[];
  inputRows: TxInputView[];
  outputRows: TxOutputDisplayRow[];
  [key: string]: unknown;
}

// ==============================================================================
// Height Estimation
// ==============================================================================

export function estimateNodeHeight(inputRowsHeight: number, outputRowsHeight: number): number {
  const rowsHeight = Math.max(inputRowsHeight, outputRowsHeight);
  return Math.max(NODE_MIN_HEIGHT, NODE_BASE_HEIGHT + rowsHeight);
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
  const nodeData = response.nodes[txid]!;
  const enrichment = response.enrichments[txid];
  const isCoinbase = nodeData.inputs.length === 1 && nodeData.inputs[0]?.prevout === null;

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

  const txLabels = (response.labels_by_type.tx[txid] ?? []).map(formatLabelEntry);
  const inputTotalHeight = inputRows.reduce((sum, row) => sum + row.rowHeight, 0);
  const outputTotalHeight = outputRows.reduce((sum, row) => sum + row.rowHeight, 0);

  const data: TxNodeData = {
    txid,
    shortTxid: shortTxid(txid),
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
export function refreshNodesFromGraph(response: GraphResponse, nodes: Node[]): Node[] {
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
        height: nodeHeight,
      },
    };
  });
}
