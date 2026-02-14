// ==============================================================================
// ELK Layout Engine
// ==============================================================================
//
// Runs the ELK.js layered layout algorithm on the transaction graph to
// compute node positions. Delegates render-model construction to model.ts.

import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { Node, Edge } from "@xyflow/react";
import type { GraphResponse } from "./types";
import { NODE_WIDTH } from "./constants";
import { buildConnectedOutputsByTx, buildNodeRenderModel } from "./model";
import type { TxNodeData } from "./model";

// Re-export view-model types so existing consumers (TxNode.tsx, App.tsx)
// can import from "./layout" without updating every import site yet.
export type {
  TxInputView,
  TxOutputView,
  TxOutputGapView,
  TxOutputRowView,
  TxOutputDisplayRow,
  TxNodeData,
} from "./model";
export { refreshNodesFromGraph } from "./model";

// Lazily import ELK so Vite can code-split the ~1MB WASM bundle into a
// separate chunk, keeping the initial page load fast.
let elkPromise: Promise<typeof import("elkjs/lib/elk.bundled.js")> | null = null;
function getElk() {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js");
  }
  return elkPromise;
}

// Lay out the transaction ancestry graph using ELK's layered algorithm.
//
// RIGHT direction: ancestry flows spending → funding (left-to-right),
// matching the mental model of "where did the money come from?"
//
// ORTHOGONAL edge routing: avoids diagonal lines that cross over nodes,
// producing cleaner visuals for dense graphs with many edges.
export async function computeLayout(
  response: GraphResponse,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodeIds = new Set(Object.keys(response.nodes));
  const connectedOutputsByTx = buildConnectedOutputsByTx(response, nodeIds);

  const visibleEdges = response.edges.filter(
    (e) => nodeIds.has(e.funding_txid) && nodeIds.has(e.spending_txid),
  );

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

  const elkEdges: ElkExtendedEdge[] = visibleEdges.map((e, i) => ({
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

  const edges: Edge[] = visibleEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.funding_txid,
    target: e.spending_txid,
    sourceHandle: `out-${e.funding_vout}`,
    targetHandle: `in-${e.input_index}`,
    type: "smoothstep",
  }));

  return { nodes, edges };
}
