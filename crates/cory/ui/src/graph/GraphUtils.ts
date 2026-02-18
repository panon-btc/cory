// ==============================================================================
// Graph Manipulation Utilities
// ==============================================================================
//
// Shared logic for graph merging, visibility computation, and layout coordination.
// These functions are pure (or near-pure) logic extracted from the store.

import type { Edge } from "@xyflow/react";
import type { Bip329Type, GraphResponse, LabelEntry, LabelsByType } from "../Types";
import { computeLayout } from "./Layout";
import type { TxFlowNode } from "./Layout";
import { refreshNodesFromGraph } from "./RenderModel";

// ==========================================================================
// Label Helpers
// ==========================================================================

export function labelBucket(
  labels: LabelsByType,
  labelType: Bip329Type,
): Record<string, LabelEntry[]> | null {
  if (labelType === "tx") return labels.tx;
  if (labelType === "input") return labels.input;
  if (labelType === "output") return labels.output;
  if (labelType === "addr") return labels.addr;
  return null;
}

// ==========================================================================
// Graph Merging & Visibility
// ==========================================================================

export function edgeKey(edge: {
  spending_txid: string;
  input_index: number;
  funding_txid: string;
  funding_vout: number;
}): string {
  return `${edge.spending_txid}:${edge.input_index}:${edge.funding_txid}:${edge.funding_vout}`;
}

export function mergeStringArrayMaps(
  current: Record<string, string[]>,
  incoming: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...current };
  for (const [key, values] of Object.entries(incoming)) {
    const existing = merged[key] ?? [];
    merged[key] = [...new Set([...existing, ...values])];
  }
  return merged;
}

export function computeMaxDepthReached(
  rootTxid: string,
  nodes: Record<string, unknown>,
  edges: Array<{ spending_txid: string; funding_txid: string }>,
): number {
  if (!nodes[rootTxid]) return 0;

  const parentsBySpending = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodes[edge.spending_txid] || !nodes[edge.funding_txid]) continue;
    const parents = parentsBySpending.get(edge.spending_txid) ?? [];
    parents.push(edge.funding_txid);
    parentsBySpending.set(edge.spending_txid, parents);
  }

  const visited = new Set<string>([rootTxid]);
  const queue: Array<{ txid: string; depth: number }> = [{ txid: rootTxid, depth: 0 }];
  let maxDepth = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > maxDepth) {
      maxDepth = current.depth;
    }

    for (const parentTxid of parentsBySpending.get(current.txid) ?? []) {
      if (visited.has(parentTxid)) continue;
      visited.add(parentTxid);
      queue.push({ txid: parentTxid, depth: current.depth + 1 });
    }
  }

  return maxDepth;
}

export function mergeGraphResponses(
  current: GraphResponse,
  incoming: GraphResponse,
): GraphResponse {
  const mergedNodes = {
    ...current.nodes,
    ...incoming.nodes,
  };
  const mergedEdgeMap = new Map<string, (typeof current.edges)[number]>();
  for (const edge of current.edges) {
    mergedEdgeMap.set(edgeKey(edge), edge);
  }
  for (const edge of incoming.edges) {
    mergedEdgeMap.set(edgeKey(edge), edge);
  }
  const mergedEdges = [...mergedEdgeMap.values()];

  return {
    ...current,
    nodes: mergedNodes,
    edges: mergedEdges,
    truncated: current.truncated || incoming.truncated,
    stats: {
      node_count: Object.keys(mergedNodes).length,
      edge_count: mergedEdges.length,
      max_depth_reached: computeMaxDepthReached(current.root_txid, mergedNodes, mergedEdges),
    },
    enrichments: {
      ...current.enrichments,
      ...incoming.enrichments,
    },
    labels_by_type: {
      tx: { ...current.labels_by_type.tx, ...incoming.labels_by_type.tx },
      input: { ...current.labels_by_type.input, ...incoming.labels_by_type.input },
      output: { ...current.labels_by_type.output, ...incoming.labels_by_type.output },
      addr: { ...current.labels_by_type.addr, ...incoming.labels_by_type.addr },
    },
    input_address_refs: {
      ...current.input_address_refs,
      ...incoming.input_address_refs,
    },
    output_address_refs: {
      ...current.output_address_refs,
      ...incoming.output_address_refs,
    },
    address_occurrences: mergeStringArrayMaps(
      current.address_occurrences,
      incoming.address_occurrences,
    ),
  };
}

export function placeExpandedParentsLeft(
  nodes: TxFlowNode[],
  existingNodeIds: Set<string>,
  expandedTxid: string,
  incoming: GraphResponse,
  anchor: { x: number; y: number; width: number } | null,
): TxFlowNode[] {
  if (!anchor) return nodes;

  const parentOrder = new Map<string, number>();
  for (const edge of incoming.edges) {
    if (edge.spending_txid !== expandedTxid) continue;
    const existing = parentOrder.get(edge.funding_txid);
    if (existing == null || edge.input_index < existing) {
      parentOrder.set(edge.funding_txid, edge.input_index);
    }
  }

  const newParents = [...parentOrder.entries()]
    .filter(([parentTxid]) => !existingNodeIds.has(parentTxid))
    .sort((a, b) => a[1] - b[1])
    .map(([parentTxid]) => parentTxid);

  if (newParents.length === 0) return nodes;

  const PARENT_X_GAP = 120;
  const PARENT_Y_GAP = 190;
  const targetX = anchor.x - (anchor.width + PARENT_X_GAP);
  const startY = anchor.y - ((newParents.length - 1) * PARENT_Y_GAP) / 2;
  const yById = new Map<string, number>(
    newParents.map((parentTxid, index) => [parentTxid, startY + index * PARENT_Y_GAP]),
  );

  return nodes.map((node) => {
    const targetY = yById.get(node.id);
    if (targetY == null) return node;
    return {
      ...node,
      position: { x: targetX, y: targetY },
    };
  });
}

export function buildParentsBySpending(
  edges: Array<{ spending_txid: string; funding_txid: string }>,
) {
  const parentsBySpending = new Map<string, string[]>();
  for (const edge of edges) {
    const parents = parentsBySpending.get(edge.spending_txid) ?? [];
    parents.push(edge.funding_txid);
    parentsBySpending.set(edge.spending_txid, parents);
  }
  return parentsBySpending;
}

export function computeAllAncestors(graph: GraphResponse, txid: string): Set<string> {
  const ancestors = new Set<string>();
  const parentsBySpending = buildParentsBySpending(graph.edges);
  const queue = [txid];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    for (const parentTxid of parentsBySpending.get(current) ?? []) {
      if (!graph.nodes[parentTxid] || ancestors.has(parentTxid)) continue;
      ancestors.add(parentTxid);
      queue.push(parentTxid);
    }
  }

  return ancestors;
}

export function computeVisibleTxids(
  graph: GraphResponse,
  expandedTxids: Record<string, true>,
  hiddenTxids: Record<string, true> = {},
): Set<string> {
  const visible = new Set<string>();
  const root = graph.root_txid;
  if (!graph.nodes[root] || hiddenTxids[root]) return visible;

  const parentsBySpending = buildParentsBySpending(graph.edges);
  const queue = [root];
  visible.add(root);

  while (queue.length > 0) {
    const spendingTxid = queue.shift();
    if (!spendingTxid) break;
    if (!expandedTxids[spendingTxid]) continue;

    for (const parentTxid of parentsBySpending.get(spendingTxid) ?? []) {
      if (!graph.nodes[parentTxid] || visible.has(parentTxid) || hiddenTxids[parentTxid]) continue;
      visible.add(parentTxid);
      queue.push(parentTxid);
    }
  }

  return visible;
}

export function applyVisibilityToElements(
  nodes: TxFlowNode[],
  edges: Edge[],
  visibleTxids: Set<string>,
): { nodes: TxFlowNode[]; edges: Edge[] } {
  return {
    nodes: nodes.map((node) => ({
      ...node,
      hidden: !visibleTxids.has(node.id),
    })),
    edges: edges.map((edge) => ({
      ...edge,
      hidden: !(visibleTxids.has(edge.source) && visibleTxids.has(edge.target)),
    })),
  };
}

/**
 * A node is "fully resolved" if all its expandable inputs (those with a prevout)
 * have corresponding edges in the graph that point to parent nodes which also
 * exist in the graph.
 */
export function isNodeFullyResolved(graph: GraphResponse | null, txid: string): boolean {
  const node = graph?.nodes[txid];
  if (!graph || !node) return false;

  const expectedInputCount = node.inputs.filter((i) => i.prevout !== null).length;
  if (expectedInputCount === 0) return true;

  const resolvedInputIndices = new Set<number>();
  for (const edge of graph.edges) {
    if (edge.spending_txid === txid && graph.nodes[edge.funding_txid]) {
      resolvedInputIndices.add(edge.input_index);
    }
  }

  return resolvedInputIndices.size >= expectedInputCount;
}

/**
 * Checks if a node has any parents currently visible in the graph.
 */
export function hasAnyResolvedInputs(graph: GraphResponse | null, txid: string): boolean {
  if (!graph) return false;
  for (const edge of graph.edges) {
    if (edge.spending_txid === txid && graph.nodes[edge.funding_txid]) {
      return true;
    }
  }
  return false;
}

// ==========================================================================
// Height-change relayout helper
// ==========================================================================

export function relayoutIfHeightsChanged(
  graph: GraphResponse,
  state: {
    nodes: TxFlowNode[];
    setNodes: (nodes: TxFlowNode[]) => void;
    setEdges: (edges: Edge[]) => void;
    hasUserMovedNodes: boolean;
  },
): void {
  const { nodes: prevNodes, setNodes, setEdges, hasUserMovedNodes } = state;
  const nextNodes = refreshNodesFromGraph(graph, prevNodes);

  const heightChanged = nextNodes.some((node, i) => {
    const prev = prevNodes[i];
    if (!prev || prev.id !== node.id) return true;
    const prevH = (prev.style?.height as number | undefined) ?? 0;
    const nextH = (node.style?.height as number | undefined) ?? 0;
    return prevH !== nextH;
  });

  setNodes(nextNodes);

  if (hasUserMovedNodes) return;

  if (heightChanged) {
    void computeLayout(graph)
      .then(({ nodes: n, edges: e }) => {
        setNodes(n);
        setEdges(e);
      })
      .catch((err) => {
        console.error("relayout after height change failed:", err);
      });
  }
}
