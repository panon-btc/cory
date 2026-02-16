// ==============================================================================
// ELK Layout Engine
// ==============================================================================
//
// Runs the ELK.js layered layout algorithm on the transaction graph to
// compute node positions. Delegates render-model construction to model.ts.

import type { ElkNode, ElkExtendedEdge, ElkPort } from "elkjs/lib/elk.bundled.js";
import { MarkerType } from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import type { GraphResponse, AncestryEdge } from "./types";
import { buildConnectedOutputsByTx, buildNodeRenderModel } from "./model";
import type { TxNodeData } from "./model";

// Typed React Flow node carrying our view-model data.
export type TxFlowNode = Node<TxNodeData>;

// Re-export view-model types so consumers import from "./layout" (the
// public API) rather than reaching into "./model" (implementation detail).
export type {
  TxInputView,
  TxOutputView,
  TxOutputGapView,
  TxOutputRowView,
  TxOutputDisplayRow,
  TxNodeData,
} from "./model";

// Lazily import ELK so Vite can code-split the ~1MB WASM bundle into a
// separate chunk, keeping the initial page load fast.
let elkPromise: Promise<typeof import("elkjs/lib/elk.bundled.js")> | null = null;
function getElk() {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js");
  }
  return elkPromise;
}

function buildVisibleEdges(response: GraphResponse, nodeIds: Set<string>): AncestryEdge[] {
  return response.edges.filter((e) => nodeIds.has(e.funding_txid) && nodeIds.has(e.spending_txid));
}

function buildModelOrderByVout(sortedTxids: string[], visibleEdges: AncestryEdge[]): string[] {
  const NEIGHBOR_WEIGHT = 100;
  const incomingBySpending = new Map<string, AncestryEdge[]>();
  const outgoingByFunding = new Map<string, AncestryEdge[]>();

  for (const edge of visibleEdges) {
    const incoming = incomingBySpending.get(edge.spending_txid) ?? [];
    incoming.push(edge);
    incomingBySpending.set(edge.spending_txid, incoming);

    const outgoing = outgoingByFunding.get(edge.funding_txid) ?? [];
    outgoing.push(edge);
    outgoingByFunding.set(edge.funding_txid, outgoing);
  }

  let order = [...sortedTxids];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const indexByTx = new Map<string, number>();
    for (let i = 0; i < order.length; i += 1) {
      indexByTx.set(order[i]!, i);
    }

    order = [...order].sort((a, b) => {
      const scoreFor = (txid: string): number => {
        const incoming = incomingBySpending.get(txid) ?? [];
        const outgoing = outgoingByFunding.get(txid) ?? [];

        let sum = 0;
        let count = 0;

        for (const edge of incoming) {
          const parentIndex = indexByTx.get(edge.funding_txid);
          if (parentIndex == null) continue;
          sum += parentIndex * NEIGHBOR_WEIGHT + edge.funding_vout;
          count += 1;
        }

        for (const edge of outgoing) {
          const childIndex = indexByTx.get(edge.spending_txid);
          if (childIndex == null) continue;
          sum += childIndex * NEIGHBOR_WEIGHT + edge.funding_vout;
          count += 1;
        }

        if (count > 0) return sum / count;
        return (indexByTx.get(txid) ?? 0) * NEIGHBOR_WEIGHT;
      };

      const scoreA = scoreFor(a);
      const scoreB = scoreFor(b);
      if (scoreA !== scoreB) return scoreA - scoreB;
      return a.localeCompare(b);
    });
  }

  return order;
}

function buildPortMaps(visibleEdges: AncestryEdge[]): {
  inputPortsByTx: Map<string, Set<number>>;
  outputPortsByTx: Map<string, Set<number>>;
} {
  const inputPortsByTx = new Map<string, Set<number>>();
  const outputPortsByTx = new Map<string, Set<number>>();

  for (const edge of visibleEdges) {
    const input = inputPortsByTx.get(edge.spending_txid) ?? new Set<number>();
    input.add(edge.input_index);
    inputPortsByTx.set(edge.spending_txid, input);

    const output = outputPortsByTx.get(edge.funding_txid) ?? new Set<number>();
    output.add(edge.funding_vout);
    outputPortsByTx.set(edge.funding_txid, output);
  }

  return { inputPortsByTx, outputPortsByTx };
}

function buildNodePorts(
  txid: string,
  inputIndices: Set<number>,
  outputIndices: Set<number>,
): ElkPort[] {
  const inputPorts = [...inputIndices]
    .sort((a, b) => a - b)
    .map<ElkPort>((index) => ({
      id: `${txid}::in::${index}`,
      layoutOptions: {
        "elk.port.side": "WEST",
        "elk.port.index": `${index}`,
      },
    }));

  const outputPorts = [...outputIndices]
    .sort((a, b) => a - b)
    .map<ElkPort>((index) => ({
      id: `${txid}::out::${index}`,
      layoutOptions: {
        "elk.port.side": "EAST",
        "elk.port.index": `${index}`,
      },
    }));

  return [...inputPorts, ...outputPorts];
}

function reorderLeftmostSourcesByVout(
  nodes: TxFlowNode[],
  visibleEdges: AncestryEdge[],
): TxFlowNode[] {
  if (nodes.length <= 1 || visibleEdges.length === 0) return nodes;

  const incomingCount = new Map<string, number>();
  const outgoingByFunding = new Map<string, AncestryEdge[]>();

  for (const edge of visibleEdges) {
    incomingCount.set(edge.spending_txid, (incomingCount.get(edge.spending_txid) ?? 0) + 1);
    const list = outgoingByFunding.get(edge.funding_txid) ?? [];
    list.push(edge);
    outgoingByFunding.set(edge.funding_txid, list);
  }

  const minX = Math.min(...nodes.map((n) => n.position.x));
  const columnTolerance = 1;
  const sourceColumn = nodes.filter(
    (n) =>
      Math.abs(n.position.x - minX) <= columnTolerance &&
      (incomingCount.get(n.id) ?? 0) === 0 &&
      (outgoingByFunding.get(n.id)?.length ?? 0) > 0,
  );

  if (sourceColumn.length <= 1) return nodes;

  const yRank = [...nodes]
    .sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id))
    .map((n) => n.id);
  const yIndexById = new Map<string, number>(yRank.map((id, i) => [id, i]));

  const scoreFor = (txid: string): number => {
    const outgoing = [...(outgoingByFunding.get(txid) ?? [])].sort(
      (a, b) => a.funding_vout - b.funding_vout,
    );
    if (outgoing.length === 0) return Number.POSITIVE_INFINITY;

    let sum = 0;
    let count = 0;
    for (const edge of outgoing) {
      const childRank = yIndexById.get(edge.spending_txid);
      if (childRank == null) continue;
      sum += childRank * 100 + edge.funding_vout;
      count += 1;
    }
    if (count === 0) return Number.POSITIVE_INFINITY;
    return sum / count;
  };

  const ordered = [...sourceColumn].sort((a, b) => {
    const sa = scoreFor(a.id);
    const sb = scoreFor(b.id);
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });

  const ySlots = [...sourceColumn].map((n) => n.position.y).sort((a, b) => a - b);
  const updatedById = new Map<string, TxFlowNode>();
  for (let i = 0; i < ordered.length; i += 1) {
    const node = ordered[i]!;
    updatedById.set(node.id, {
      ...node,
      position: { ...node.position, y: ySlots[i] ?? node.position.y },
    });
  }

  return nodes.map((n) => updatedById.get(n.id) ?? n);
}

function reorderParallelBridgeGroups(
  nodes: TxFlowNode[],
  visibleEdges: AncestryEdge[],
): TxFlowNode[] {
  if (nodes.length <= 2 || visibleEdges.length === 0) return nodes;
  const BRIDGE_MIN_VERTICAL_DELTA = 260;

  const incomingBySpending = new Map<string, AncestryEdge[]>();
  const outgoingByFunding = new Map<string, AncestryEdge[]>();
  for (const edge of visibleEdges) {
    const incoming = incomingBySpending.get(edge.spending_txid) ?? [];
    incoming.push(edge);
    incomingBySpending.set(edge.spending_txid, incoming);

    const outgoing = outgoingByFunding.get(edge.funding_txid) ?? [];
    outgoing.push(edge);
    outgoingByFunding.set(edge.funding_txid, outgoing);
  }

  const groups = new Map<string, TxFlowNode[]>();
  for (const node of nodes) {
    const incoming = incomingBySpending.get(node.id) ?? [];
    const outgoing = outgoingByFunding.get(node.id) ?? [];
    if (incoming.length === 0 || outgoing.length === 0) continue;

    const parents = [...new Set(incoming.map((e) => e.funding_txid))].sort();
    const children = [...new Set(outgoing.map((e) => e.spending_txid))].sort();
    if (parents.length === 0 || children.length === 0) continue;

    const key = `p:${parents.join(",")}|c:${children.join(",")}`;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }

  const updatedById = new Map<string, TxFlowNode>();
  for (const siblings of groups.values()) {
    if (siblings.length <= 1) continue;

    const yRank = [...nodes]
      .sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id))
      .map((n) => n.id);
    const yIndexById = new Map<string, number>(yRank.map((id, i) => [id, i]));

    const leftKey = (edge: AncestryEdge): number => {
      const rank = yIndexById.get(edge.funding_txid) ?? Number.MAX_SAFE_INTEGER;
      return rank * 1_000 + edge.funding_vout;
    };
    const rightKey = (edge: AncestryEdge): number => {
      const rank = yIndexById.get(edge.spending_txid) ?? Number.MAX_SAFE_INTEGER;
      return rank * 1_000 + edge.input_index;
    };

    const inversionCost = (orderedIds: string[]): number => {
      let cost = 0;
      for (let i = 0; i < orderedIds.length; i += 1) {
        for (let j = i + 1; j < orderedIds.length; j += 1) {
          const a = orderedIds[i]!;
          const b = orderedIds[j]!;

          const aIncoming = incomingBySpending.get(a) ?? [];
          const bIncoming = incomingBySpending.get(b) ?? [];
          for (const ea of aIncoming) {
            for (const eb of bIncoming) {
              if (leftKey(ea) > leftKey(eb)) cost += 1;
            }
          }

          const aOutgoing = outgoingByFunding.get(a) ?? [];
          const bOutgoing = outgoingByFunding.get(b) ?? [];
          for (const ea of aOutgoing) {
            for (const eb of bOutgoing) {
              if (rightKey(ea) > rightKey(eb)) cost += 1;
            }
          }
        }
      }
      return cost;
    };

    const fallbackOrder = [...siblings]
      .sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id))
      .map((n) => n.id);

    const ids = siblings.map((n) => n.id).sort();
    let bestOrder: string[] = [...fallbackOrder];
    let bestCost = inversionCost(bestOrder);

    // Exact search for small groups. This directly minimizes avoidable
    // crossings on both parent->group and group->child sides.
    if (ids.length <= 7) {
      const used = new Set<string>();
      const current: string[] = [];
      const visit = () => {
        if (current.length === ids.length) {
          const cost = inversionCost(current);
          const currentKey = current.join("|");
          const bestKey = bestOrder.join("|");
          if (cost < bestCost || (cost === bestCost && currentKey < bestKey)) {
            bestCost = cost;
            bestOrder = [...current];
          }
          return;
        }
        for (const id of ids) {
          if (used.has(id)) continue;
          used.add(id);
          current.push(id);
          visit();
          current.pop();
          used.delete(id);
        }
      };
      visit();
    }

    const nodeById = new Map<string, TxFlowNode>(siblings.map((n) => [n.id, n]));
    const ordered = bestOrder.map((id) => nodeById.get(id)!).filter(Boolean);

    const currentYs = [...siblings].map((n) => n.position.y).sort((a, b) => a - b);
    const currentSpread = currentYs[currentYs.length - 1]! - currentYs[0]!;
    const desiredSpread = (ordered.length - 1) * BRIDGE_MIN_VERTICAL_DELTA;
    const ySlots =
      currentSpread >= desiredSpread
        ? currentYs
        : (() => {
            const centerY = currentYs.reduce((sum, y) => sum + y, 0) / currentYs.length;
            const startY = centerY - desiredSpread / 2;
            return ordered.map((_, i) => startY + i * BRIDGE_MIN_VERTICAL_DELTA);
          })();

    for (let i = 0; i < ordered.length; i += 1) {
      const node = ordered[i]!;
      updatedById.set(node.id, {
        ...node,
        position: { ...node.position, y: ySlots[i] ?? node.position.y },
      });
    }
  }

  return nodes.map((n) => updatedById.get(n.id) ?? n);
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
): Promise<{ nodes: TxFlowNode[]; edges: Edge[] }> {
  const nodeIds = new Set(Object.keys(response.nodes));
  const connectedOutputsByTx = buildConnectedOutputsByTx(response, nodeIds);
  const visibleEdges = buildVisibleEdges(response, nodeIds);

  // Build render models once and reuse for both ELK sizing and final nodes,
  // avoiding duplicate computation of node data and heights.
  const renderModels = new Map<string, { data: TxNodeData; nodeHeight: number }>();
  const sortedTxids = Object.keys(response.nodes).sort();
  for (const txid of sortedTxids) {
    renderModels.set(txid, buildNodeRenderModel(response, txid, connectedOutputsByTx));
  }

  const modelOrder = buildModelOrderByVout(sortedTxids, visibleEdges);
  const { inputPortsByTx, outputPortsByTx } = buildPortMaps(visibleEdges);

  const children: ElkNode[] = modelOrder.map((txid) => {
    const model = renderModels.get(txid)!;
    const ports = buildNodePorts(
      txid,
      inputPortsByTx.get(txid) ?? new Set<number>(),
      outputPortsByTx.get(txid) ?? new Set<number>(),
    );

    return {
      id: txid,
      width: model.data.nodeWidth,
      height: model.nodeHeight,
      ports,
      layoutOptions: {
        "elk.portConstraints": "FIXED_ORDER",
      },
    };
  });

  const elkEdges: ElkExtendedEdge[] = visibleEdges.map((e, i) => ({
    id: `e-${i}`,
    sources: [`${e.funding_txid}::out::${e.funding_vout}`],
    targets: [`${e.spending_txid}::in::${e.input_index}`],
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
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.considerModelOrder.portModelOrder": "true",
      // Intentionally prioritize vout-driven model order over ELK reordering.
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    },
    children,
    edges: elkEdges,
  };

  const ELK = (await getElk()).default;
  const elk = new ELK();
  const laid = await elk.layout(graph);

  const nodes: TxFlowNode[] = (laid.children ?? []).map((n: ElkNode) => {
    const txid = n.id;
    const model = renderModels.get(txid)!;

    return {
      id: txid,
      type: "tx",
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      style: {
        width: model.data.nodeWidth,
        height: model.nodeHeight,
      },
      data: model.data,
    };
  });
  const reorderedNodes = reorderLeftmostSourcesByVout(nodes, visibleEdges);
  const bridgeReorderedNodes = reorderParallelBridgeGroups(reorderedNodes, visibleEdges);

  const edges: Edge[] = visibleEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.funding_txid,
    target: e.spending_txid,
    sourceHandle: `out-${e.funding_vout}`,
    targetHandle: `in-${e.input_index}`,
    type: "default",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "var(--border)",
    },
    style: {
      stroke: "var(--border)",
      strokeWidth: 1.5,
    },
  }));

  return { nodes: bridgeReorderedNodes, edges };
}
