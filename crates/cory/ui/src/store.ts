// ==============================================================================
// Zustand Store
// ==============================================================================
//
// Central state store. Store methods are inherently stable references and
// live outside React's render cycle, eliminating stale-closure problems.

import { create } from "zustand";
import type { Edge } from "@xyflow/react";
import toast from "react-hot-toast";
import type {
  Bip329Type,
  GraphResponse,
  HistoryEntry,
  LabelEntry,
  LabelFileSummary,
  LabelsByType,
} from "./types";
import {
  deleteLabelInFile,
  errorMessage,
  fetchGraph,
  fetchHistory,
  fetchLabelFiles,
  isAuthError,
  setApiToken as setApiTokenInModule,
  setLabelInFile,
} from "./api";
import { SEARCH_DEPTH_DEFAULT, SEARCH_DEPTH_MAX_FALLBACK } from "./constants";
import { computeLayout } from "./layout";
import type { TxFlowNode } from "./layout";
import { refreshNodesFromGraph } from "./model";

// ==========================================================================
// Module-scope mutable variables (not reactive state)
// ==========================================================================
//
// These replace useRef — mutable values that persist across calls without
// triggering renders. They guard against race conditions when the user
// types quickly and multiple searches overlap.

let searchAbortController: AbortController | null = null;
let searchId = 0;
let lastSearchTxid = "";

// ==========================================================================
// URL helpers
// ==========================================================================

function replaceUrlSearchParams(search: string, depth: number): void {
  const searchTrimmed = search.trim();
  const parts: string[] = [];

  if (searchTrimmed) {
    parts.push(`search=${encodeURIComponent(searchTrimmed)}`);
    parts.push(`depth=${encodeURIComponent(String(depth))}`);
  }

  const next = `${window.location.pathname}${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) {
    window.history.replaceState(null, "", next);
  }
}

// ==========================================================================
// Label bucket helper
// ==========================================================================

// Map a BIP-329 label type to the corresponding bucket in LabelsByType.
// Returns null for types we don't store client-side (e.g. "pubkey", "xpub").
function labelBucket(
  labels: LabelsByType,
  labelType: Bip329Type,
): Record<string, LabelEntry[]> | null {
  if (labelType === "tx") return labels.tx;
  if (labelType === "input") return labels.input;
  if (labelType === "output") return labels.output;
  if (labelType === "addr") return labels.addr;
  return null;
}

function edgeKey(edge: {
  spending_txid: string;
  input_index: number;
  funding_txid: string;
  funding_vout: number;
}): string {
  return `${edge.spending_txid}:${edge.input_index}:${edge.funding_txid}:${edge.funding_vout}`;
}

function mergeStringArrayMaps(
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

function computeMaxDepthReached(
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

function mergeGraphResponses(current: GraphResponse, incoming: GraphResponse): GraphResponse {
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

function placeExpandedParentsLeft(
  nodes: TxFlowNode[],
  existingNodeIds: Set<string>,
  expandedTxid: string,
  incoming: GraphResponse,
  anchor: { x: number; y: number; width: number } | null,
): TxFlowNode[] {
  if (!anchor) return nodes;

  // Preserve a stable vertical ordering for newly added parents by using
  // the smallest input index where each parent is referenced.
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

  // Keep new parents visibly to the left of the expanded node and centered
  // around its current vertical position.
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
      position: {
        x: targetX,
        y: targetY,
      },
    };
  });
}

// ==========================================================================
// Store interface
// ==========================================================================

interface AppState {
  // Graph display
  nodes: TxFlowNode[];
  edges: Edge[];
  graph: GraphResponse | null;
  selectedTxid: string | null;
  loading: boolean;
  error: string | null;
  authError: string | null;
  hasUserMovedNodes: boolean;
  expandingTxids: Record<string, true>;

  // Labels
  labelFiles: LabelFileSummary[];
  historyEntries: HistoryEntry[];

  // API token (persisted to sessionStorage)
  apiToken: string;

  // Search params tracked for URL sync.
  searchParamTxid: string;
  searchDepth: number;
  searchDepthMax: number;
  searchFocusRequestId: number;
  searchFocusTxid: string | null;

  // Actions
  doSearch: (
    txid: string,
    opts?: { preserveSelectedTxid?: string | null; quietErrors?: boolean },
  ) => Promise<void>;
  expandNodeInputs: (txid: string) => Promise<void>;
  setSelectedTxid: (txid: string | null) => void;
  setNodes: (updater: TxFlowNode[] | ((prev: TxFlowNode[]) => TxFlowNode[])) => void;
  setEdges: (updater: Edge[] | ((prev: Edge[]) => Edge[])) => void;
  setAuthError: (message: string | null) => void;
  setHasUserMovedNodes: (moved: boolean) => void;
  /** Returns true (and sets authError) if err is a 401. Callers can
   *  short-circuit their own error handling when this returns true. */
  handleAuthError: (err: unknown) => boolean;
  setApiToken: (token: string) => void;
  setSearchDepth: (depth: number) => void;
  setSearchDepthMax: (maxDepth: number) => void;
  refreshLabelFiles: () => Promise<LabelFileSummary[]>;
  refreshHistory: () => Promise<HistoryEntry[]>;
  saveLabel: (fileId: string, labelType: Bip329Type, refId: string, label: string) => Promise<void>;
  deleteLabel: (fileId: string, labelType: Bip329Type, refId: string) => Promise<void>;
  labelsChanged: (opts?: { refreshGraph?: boolean }) => Promise<void>;
}

// ==========================================================================
// Store creation
// ==========================================================================

export const useAppStore = create<AppState>((set, get) => ({
  nodes: [],
  edges: [],
  graph: null,
  selectedTxid: null,
  loading: false,
  error: null,
  authError: null,
  hasUserMovedNodes: false,
  expandingTxids: {},
  labelFiles: [],
  historyEntries: [],
  apiToken: "",
  searchParamTxid: "",
  searchDepth: SEARCH_DEPTH_DEFAULT,
  searchDepthMax: SEARCH_DEPTH_MAX_FALLBACK,
  searchFocusRequestId: 0,
  searchFocusTxid: null,

  setSelectedTxid: (txid) => set({ selectedTxid: txid }),

  setNodes: (updater) =>
    set((state) => ({
      nodes: typeof updater === "function" ? updater(state.nodes) : updater,
    })),

  setEdges: (updater) =>
    set((state) => ({
      edges: typeof updater === "function" ? updater(state.edges) : updater,
    })),

  setAuthError: (message) => set({ authError: message }),

  setHasUserMovedNodes: (moved) => set({ hasUserMovedNodes: moved }),

  handleAuthError: (err) => {
    if (!isAuthError(err)) return false;
    set({ authError: errorMessage(err, "request failed") });
    return true;
  },

  setApiToken: (token) => {
    const trimmed = token.trim();
    set({ apiToken: trimmed, authError: null });
    if (trimmed) {
      sessionStorage.setItem("cory:apiToken", trimmed);
    } else {
      sessionStorage.removeItem("cory:apiToken");
    }
    setApiTokenInModule(trimmed);
  },

  setSearchDepth: (depth) => {
    if (!Number.isFinite(depth)) return;
    const normalized = Math.trunc(depth);
    if (normalized < 1) return;
    set((state) => ({ searchDepth: Math.min(normalized, state.searchDepthMax) }));
  },

  setSearchDepthMax: (maxDepth) => {
    if (!Number.isFinite(maxDepth)) return;
    const normalizedMax = Math.trunc(maxDepth);
    if (normalizedMax < 1) return;
    set((state) => ({
      searchDepthMax: normalizedMax,
      searchDepth: Math.min(state.searchDepth, normalizedMax),
    }));
  },

  refreshLabelFiles: async () => {
    try {
      const files = await fetchLabelFiles();
      set({ labelFiles: files, authError: null });
      return files;
    } catch (e) {
      get().handleAuthError(e);
      // Keep current list if label file metadata request fails.
      return get().labelFiles;
    }
  },

  refreshHistory: async () => {
    try {
      const { entries } = await fetchHistory();
      set({ historyEntries: entries, authError: null });
      return entries;
    } catch (e) {
      get().handleAuthError(e);
      // Keep current list if history request fails.
      return get().historyEntries;
    }
  },

  doSearch: async (txid, opts) => {
    // Abort any in-flight search request so we don't apply stale results.
    searchAbortController?.abort();
    const controller = new AbortController();
    searchAbortController = controller;
    const thisSearchId = ++searchId;

    const maxDepth = get().searchDepth;
    lastSearchTxid = txid;
    set({ searchParamTxid: txid, loading: true, error: null });
    replaceUrlSearchParams(txid, maxDepth);

    try {
      const resp = await fetchGraph(txid, { signal: controller.signal, maxDepth });
      const { nodes: n, edges: e } = await computeLayout(resp);

      // Guard: if another search was started while we were awaiting,
      // discard these results silently.
      if (searchId !== thisSearchId) return;

      const preservedTxid = opts?.preserveSelectedTxid;
      const searchedTxid = txid.trim();
      const searchTargetTxid =
        searchedTxid && resp.nodes[searchedTxid] ? searchedTxid : resp.root_txid;
      const nextSelectedTxid =
        preservedTxid && resp.nodes[preservedTxid] ? preservedTxid : searchTargetTxid;
      const selectedNodes = n.map((node) => ({
        ...node,
        selected: node.id === nextSelectedTxid,
      }));

      set({
        graph: resp,
        nodes: selectedNodes,
        edges: e,
        selectedTxid: nextSelectedTxid,
        searchFocusRequestId: get().searchFocusRequestId + 1,
        searchFocusTxid: searchTargetTxid,
        authError: null,
        hasUserMovedNodes: false,
        expandingTxids: {},
      });

      // History refresh is best-effort and should not break graph rendering.
      await get().refreshHistory();
    } catch (e) {
      // Aborted requests are not errors — just ignore them.
      if ((e as Error).name === "AbortError") return;
      if (searchId !== thisSearchId) return;

      if (get().handleAuthError(e)) {
        window.alert(errorMessage(e, "request failed"));
        return;
      }

      if (!opts?.quietErrors) {
        set({
          error: errorMessage(e, "Failed to load graph"),
          graph: null,
          nodes: [],
          edges: [],
        });
      }
    } finally {
      if (searchId === thisSearchId) {
        set({ loading: false });
      }
    }
  },

  expandNodeInputs: async (txid) => {
    const state = get();
    const baseGraph = state.graph;
    if (!baseGraph || !baseGraph.nodes[txid]) return;
    if (state.loading || state.expandingTxids[txid]) return;

    const sourceNode = baseGraph.nodes[txid];
    if (!sourceNode.inputs.some((input) => input.prevout !== null)) return;

    set((current) => ({
      expandingTxids: {
        ...current.expandingTxids,
        [txid]: true,
      },
      error: null,
    }));

    try {
      const incoming = await fetchGraph(txid, { maxDepth: 1, recordHistory: false });
      const latest = get();
      const currentGraph = latest.graph;
      if (!currentGraph || !currentGraph.nodes[txid]) return;

      const mergedGraph = mergeGraphResponses(currentGraph, incoming);
      const hadUserMovedNodes = latest.hasUserMovedNodes;
      const existingNodeIds = new Set(Object.keys(currentGraph.nodes));
      const expandedNode = latest.nodes.find((node) => node.id === txid);
      const previousPositions = new Map<string, TxFlowNode["position"]>(
        latest.nodes.map((node) => [node.id, node.position]),
      );

      const { nodes: laidOutNodes, edges } = await computeLayout(mergedGraph);
      const selectedTxid = get().selectedTxid;
      const mergedNodes = laidOutNodes.map((node) => {
        if (hadUserMovedNodes && existingNodeIds.has(node.id)) {
          const previousPosition = previousPositions.get(node.id);
          if (previousPosition) {
            return {
              ...node,
              position: previousPosition,
              selected: node.id === selectedTxid,
            };
          }
        }
        return {
          ...node,
          selected: node.id === selectedTxid,
        };
      });
      const anchoredMergedNodes = placeExpandedParentsLeft(
        mergedNodes,
        existingNodeIds,
        txid,
        incoming,
        expandedNode
          ? {
              x: expandedNode.position.x,
              y: expandedNode.position.y,
              width: typeof expandedNode.style?.width === "number" ? expandedNode.style.width : 320,
            }
          : null,
      );

      set({
        graph: mergedGraph,
        nodes: anchoredMergedNodes,
        edges,
        authError: null,
      });
    } catch (e) {
      if (get().handleAuthError(e)) {
        toast.error(errorMessage(e, "request failed"), { id: "graph-expand-error" });
        return;
      }
      toast.error(errorMessage(e, "Failed to expand node inputs"), { id: "graph-expand-error" });
    } finally {
      set((current) => {
        if (!current.expandingTxids[txid]) return current;
        const nextExpanding = { ...current.expandingTxids };
        delete nextExpanding[txid];
        return { expandingTxids: nextExpanding };
      });
    }
  },

  saveLabel: async (fileId, labelType, refId, label) => {
    let summary;
    try {
      summary = await setLabelInFile(fileId, labelType, refId, label);
      set({ authError: null });
    } catch (e) {
      get().handleAuthError(e);
      throw e;
    }

    // Inline upsert into graph state (replaces labels.ts:upsertLabel).
    set((state) => {
      const { graph } = state;
      if (!graph) return state;

      const next = {
        ...graph,
        labels_by_type: {
          tx: { ...graph.labels_by_type.tx },
          input: { ...graph.labels_by_type.input },
          output: { ...graph.labels_by_type.output },
          addr: { ...graph.labels_by_type.addr },
        },
      };

      const bucket = labelBucket(next.labels_by_type, labelType);
      if (!bucket) return state;

      const existing = [...(bucket[refId] ?? [])];
      const idx = existing.findIndex((entry) => entry.file_id === fileId);
      const fileInfo = get().labelFiles.find((f) => f.id === fileId);
      const row: LabelEntry = {
        file_id: fileId,
        file_name: summary.name,
        file_kind: fileInfo?.kind ?? "browser_rw",
        editable: fileInfo?.editable ?? true,
        label,
      };
      if (idx >= 0) {
        existing[idx] = row;
      } else {
        existing.push(row);
      }
      bucket[refId] = existing;

      return { graph: next };
    });

    await get().refreshLabelFiles();
  },

  deleteLabel: async (fileId, labelType, refId) => {
    try {
      await deleteLabelInFile(fileId, labelType, refId);
      set({ authError: null });
    } catch (e) {
      get().handleAuthError(e);
      throw e;
    }

    // Inline removal from graph state (replaces labels.ts:removeLabel).
    set((state) => {
      const { graph } = state;
      if (!graph) return state;

      const next = {
        ...graph,
        labels_by_type: {
          tx: { ...graph.labels_by_type.tx },
          input: { ...graph.labels_by_type.input },
          output: { ...graph.labels_by_type.output },
          addr: { ...graph.labels_by_type.addr },
        },
      };

      const bucket = labelBucket(next.labels_by_type, labelType);
      if (!bucket) return state;

      const existing = bucket[refId] ?? [];
      bucket[refId] = existing.filter((entry) => entry.file_id !== fileId);

      return { graph: next };
    });

    await get().refreshLabelFiles();
  },

  labelsChanged: async (opts) => {
    await get().refreshLabelFiles();
    if (opts?.refreshGraph === false) return;

    if (lastSearchTxid) {
      await get().doSearch(lastSearchTxid, {
        preserveSelectedTxid: get().selectedTxid,
        quietErrors: true,
      });
    }
  },
}));

// ==========================================================================
// Height-change relayout helper
// ==========================================================================
//
// Label edits change node heights (more label lines = taller node) without
// changing the graph topology. This function detects height changes and
// reruns ELK layout so nodes don't overlap after growing/shrinking.
// Called from a useEffect in App.tsx.

export function relayoutIfHeightsChanged(graph: GraphResponse): void {
  const { nodes: prevNodes, setNodes, setEdges, hasUserMovedNodes } = useAppStore.getState();
  const nextNodes = refreshNodesFromGraph(graph, prevNodes);

  const heightChanged = nextNodes.some((node, i) => {
    const prev = prevNodes[i];
    if (!prev || prev.id !== node.id) return true;
    const prevH = (prev.style?.height as number | undefined) ?? 0;
    const nextH = (node.style?.height as number | undefined) ?? 0;
    return prevH !== nextH;
  });

  setNodes(nextNodes);

  // If the user dragged nodes, preserve their manual arrangement and only
  // refresh node content/size. Re-running ELK would snap nodes back.
  if (hasUserMovedNodes) {
    return;
  }

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
