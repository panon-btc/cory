import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { Node, Edge } from "@xyflow/react";
import type { GraphResponse, LabelEntry } from "./types";

// Lazily import ELK so Vite can code-split the ~1MB WASM bundle into a
// separate chunk, keeping the initial page load fast.
let elkPromise: Promise<typeof import("elkjs/lib/elk.bundled.js")> | null = null;
function getElk() {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js");
  }
  return elkPromise;
}

const NODE_WIDTH = 360;
const NODE_MIN_HEIGHT = 140;
const NODE_BASE_HEIGHT = 110;
const PRIMARY_ROW_HEIGHT = 18;
const LABEL_LINE_HEIGHT = 10;

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
  outputRows: TxOutputView[];
  [key: string]: unknown;
}

function shortTxid(txid: string): string {
  if (txid.length <= 36) return txid;
  return txid.substring(0, 18) + "\u2026" + txid.substring(txid.length - 18);
}

function estimateNodeHeight(inputRowsHeight: number, outputRowsHeight: number): number {
  const rowsHeight = Math.max(inputRowsHeight, outputRowsHeight);
  return Math.max(NODE_MIN_HEIGHT, NODE_BASE_HEIGHT + rowsHeight);
}

function formatLabelEntry(entry: LabelEntry): string {
  return `${entry.file_name}/${entry.label}`;
}

function buildConnectedOutputsByTx(
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

function buildNodeRenderModel(
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
  const outputRows: TxOutputView[] = nodeData.outputs.map((output, index) => {
    const outputRef = `${txid}:${index}`;
    const outputLabels = response.labels_by_type.output[outputRef] ?? [];
    const address = response.output_address_refs[outputRef] ?? null;
    const addrLabels = address ? (response.labels_by_type.addr[address] ?? []) : [];
    const labelLines = [...addrLabels.map(formatLabelEntry), ...outputLabels.map(formatLabelEntry)];

    return {
      index,
      value: output.value,
      scriptType: output.script_type,
      connected: connectedIndices.has(index),
      address,
      labelLines,
      rowHeight: PRIMARY_ROW_HEIGHT + labelLines.length * LABEL_LINE_HEIGHT,
    };
  });

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

export async function computeLayout(
  response: GraphResponse,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodeIds = new Set(Object.keys(response.nodes));
  const connectedOutputsByTx = buildConnectedOutputsByTx(response, nodeIds);

  // Build render models once and reuse for both ELK sizing and final nodes,
  // avoiding duplicate computation of node data and heights.
  const renderModels = new Map<string, { data: TxNodeData; nodeHeight: number }>();
  const sortedTxids = Object.keys(response.nodes).sort();
  for (const txid of sortedTxids) {
    renderModels.set(txid, buildNodeRenderModel(response, txid, connectedOutputsByTx));
  }

  const children: ElkNode[] = sortedTxids.map((txid) => {
    const model = renderModels.get(txid)!;
    return {
      id: txid,
      width: NODE_WIDTH,
      height: model.nodeHeight,
    };
  });

  const elkEdges: ElkExtendedEdge[] = response.edges
    .filter((e) => nodeIds.has(e.funding_txid) && nodeIds.has(e.spending_txid))
    .map((e, i) => ({
      id: `e-${i}`,
      sources: [e.funding_txid],
      targets: [e.spending_txid],
    }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "44",
      "elk.spacing.edgeNode": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children,
    edges: elkEdges,
  };

  const ELK = (await getElk()).default;
  const elk = new ELK();
  const laid = await elk.layout(graph);

  const nodes: Node[] = (laid.children ?? []).map((n: ElkNode) => {
    const txid = n.id;
    const model = renderModels.get(txid)!;

    return {
      id: txid,
      type: "tx",
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      style: {
        height: model.nodeHeight,
      },
      data: model.data,
    };
  });

  const edges: Edge[] = response.edges
    .filter((e) => nodeIds.has(e.funding_txid) && nodeIds.has(e.spending_txid))
    .map((e, i) => ({
      id: `e-${i}`,
      source: e.funding_txid,
      target: e.spending_txid,
      sourceHandle: `out-${e.funding_vout}`,
      targetHandle: `in-${e.input_index}`,
      type: "smoothstep",
    }));

  return { nodes, edges };
}
