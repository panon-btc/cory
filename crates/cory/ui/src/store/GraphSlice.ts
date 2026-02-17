// ==============================================================================
// Graph Store Slice
// ==============================================================================

import { type StateCreator } from "zustand";
import { type AppState } from "./AppStore";
import type { Edge } from "@xyflow/react";
import type { GraphResponse } from "../Types";
import { fetchGraph, errorMessage } from "../Api";
import { SEARCH_DEPTH_DEFAULT, SEARCH_DEPTH_MAX_FALLBACK } from "../Constants";
import { computeLayout, type TxFlowNode } from "../graph/Layout";
import {
  applyVisibilityToElements,
  computeVisibleTxids,
  isNodeFullyResolved,
  hasAnyResolvedInputs,
  mergeGraphResponses,
  placeExpandedParentsLeft,
  relayoutIfHeightsChanged,
} from "../graph/GraphUtils";
import { replaceUrlSearchParams } from "../utils/Navigation";
import { internalState } from "./InternalState";

function hasExpandableInputs(graph: GraphResponse, txid: string): boolean {
  const node = graph.nodes[txid];
  return node ? node.inputs.some((input) => input.prevout !== null) : false;
}

export interface GraphSlice {
  nodes: TxFlowNode[];
  edges: Edge[];
  graph: GraphResponse | null;
  selectedTxid: string | null;
  loading: boolean;
  error: string | null;
  hasUserMovedNodes: boolean;
  expandedTxids: Record<string, true>;
  resolvedTxids: Record<string, true>;
  expandingTxids: Record<string, true>;
  searchParamTxid: string;
  searchDepth: number;
  searchDepthMax: number;
  searchFocusRequestId: number;
  searchFocusTxid: string | null;

  doSearch: (
    txid: string,
    opts?: { preserveSelectedTxid?: string | null; quietErrors?: boolean },
  ) => Promise<void>;
  toggleNodeInputs: (txid: string) => Promise<void>;
  setSelectedTxid: (txid: string | null) => void;
  setNodes: (updater: TxFlowNode[] | ((prev: TxFlowNode[]) => TxFlowNode[])) => void;
  setEdges: (updater: Edge[] | ((prev: Edge[]) => Edge[])) => void;
  setHasUserMovedNodes: (moved: boolean) => void;
  setSearchDepth: (depth: number) => void;
  setSearchDepthMax: (maxDepth: number) => void;
  triggerRelayout: () => void;
}

export const createGraphSlice: StateCreator<AppState, [], [], GraphSlice> = (set, get) => ({
  nodes: [],
  edges: [],
  graph: null,
  selectedTxid: null,
  loading: false,
  error: null,
  hasUserMovedNodes: false,
  expandedTxids: {},
  resolvedTxids: {},
  expandingTxids: {},
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

  setHasUserMovedNodes: (moved) => set({ hasUserMovedNodes: moved }),

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

  doSearch: async (txid, opts) => {
    internalState.searchAbortController?.abort();
    const controller = new AbortController();
    internalState.searchAbortController = controller;
    const thisSearchId = ++internalState.searchId;

    const maxDepth = get().searchDepth;
    internalState.lastSearchTxid = txid;
    set({ searchParamTxid: txid, loading: true, error: null });
    replaceUrlSearchParams(txid, maxDepth);

    try {
      const resp = await fetchGraph(txid, { signal: controller.signal, maxDepth });
      const { nodes: n, edges: e } = await computeLayout(resp);

      if (internalState.searchId !== thisSearchId) return;

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

      // Initialize expanded/resolved states based on what we actually fetched.
      // Truncated nodes (no parents in this response) remain collapsed.
      const initialExpanded: Record<string, true> = {};
      const initialResolved: Record<string, true> = {};
      for (const tid of Object.keys(resp.nodes)) {
        if (hasAnyResolvedInputs(resp, tid)) {
          initialExpanded[tid] = true;
        }
        if (isNodeFullyResolved(resp, tid)) {
          initialResolved[tid] = true;
        }
      }

      set({
        graph: resp,
        nodes: selectedNodes,
        edges: e,
        selectedTxid: nextSelectedTxid,
        searchFocusRequestId: get().searchFocusRequestId + 1,
        searchFocusTxid: searchTargetTxid,
        authError: null,
        hasUserMovedNodes: false,
        expandedTxids: initialExpanded,
        resolvedTxids: initialResolved,
        expandingTxids: {},
      });

      await get().refreshHistory();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (internalState.searchId !== thisSearchId) return;

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
      if (internalState.searchId === thisSearchId) {
        set({ loading: false });
      }
    }
  },

  toggleNodeInputs: async (txid) => {
    const state = get();
    const baseGraph = state.graph;
    if (!baseGraph || !baseGraph.nodes[txid]) return;
    if (state.loading || state.expandingTxids[txid]) return;

    if (!hasExpandableInputs(baseGraph, txid)) return;

    const isExpanded = Boolean(state.expandedTxids[txid]);
    const fullyResolved = isNodeFullyResolved(baseGraph, txid);

    // If it's expanded and we have all parents, toggle means COLLAPSE.
    if (isExpanded && fullyResolved) {
      set((current) => {
        if (!current.graph) return current;
        const nextExpanded: Record<string, true> = { ...current.expandedTxids };
        delete nextExpanded[txid];
        const visibleTxids = computeVisibleTxids(current.graph, nextExpanded);
        const hidden = applyVisibilityToElements(current.nodes, current.edges, visibleTxids);
        return {
          expandedTxids: nextExpanded,
          nodes: hidden.nodes,
          edges: hidden.edges,
        };
      });
      return;
    }

    // Otherwise, toggle means EXPAND (either from memory or from server).
    if (!fullyResolved) {
      set((current) => ({
        expandingTxids: { ...current.expandingTxids, [txid]: true },
        error: null,
      }));
    }

    try {
      if (fullyResolved) {
        // We have the data but it was hidden.
        set((current) => {
          if (!current.graph || !current.graph.nodes[txid]) return current;
          const nextExpanded: Record<string, true> = { ...current.expandedTxids, [txid]: true };
          const visibleTxids = computeVisibleTxids(current.graph, nextExpanded);
          const visible = applyVisibilityToElements(current.nodes, current.edges, visibleTxids);
          return {
            expandedTxids: nextExpanded,
            nodes: visible.nodes,
            edges: visible.edges,
          };
        });
        return;
      }

      const incoming = await fetchGraph(txid, { maxDepth: 1, recordHistory: false });
      const latest = get();
      const currentGraph = latest.graph;
      if (!currentGraph || !currentGraph.nodes[txid]) return;

      const mergedGraph = mergeGraphResponses(currentGraph, incoming);
      const nextExpanded = { ...latest.expandedTxids };
      const nextResolved = { ...latest.resolvedTxids };

      for (const tid of Object.keys(mergedGraph.nodes)) {
        if (hasAnyResolvedInputs(mergedGraph, tid)) {
          nextExpanded[tid] = true;
        }
        if (isNodeFullyResolved(mergedGraph, tid)) {
          nextResolved[tid] = true;
        }
      }

      const visibleTxids = computeVisibleTxids(mergedGraph, nextExpanded);
      const hadUserMovedNodes = latest.hasUserMovedNodes;
      const existingNodeIds = new Set(Object.keys(currentGraph.nodes));
      const expandedNode = latest.nodes.find((node) => node.id === txid);
      const previousPositions = new Map<string, TxFlowNode["position"]>(
        latest.nodes.map((node) => [node.id, node.position]),
      );
      const selectedTxid = latest.selectedTxid;

      const { nodes: laidOutVisibleNodes, edges: visibleEdges } = await computeLayout(mergedGraph, {
        visibleNodeIds: visibleTxids,
      });
      const mergedNodes = laidOutVisibleNodes.map((node) => {
        if (hadUserMovedNodes && existingNodeIds.has(node.id)) {
          const previousPosition = previousPositions.get(node.id);
          if (previousPosition) {
            return {
              ...node,
              position: previousPosition,
              selected: node.id === selectedTxid,
              hidden: false,
            };
          }
        }
        return {
          ...node,
          selected: node.id === selectedTxid,
          hidden: false,
        };
      });
      const anchoredVisibleNodes = placeExpandedParentsLeft(
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

      const visibleNodeMap = new Map<string, TxFlowNode>(
        anchoredVisibleNodes.map((node) => [node.id, node]),
      );
      const hiddenExistingNodes = latest.nodes
        .filter((node) => !visibleNodeMap.has(node.id))
        .map((node) => ({ ...node, selected: node.id === selectedTxid, hidden: true }));
      const allNodes = [...anchoredVisibleNodes, ...hiddenExistingNodes];

      const visibleEdgeKeySet = new Set(
        visibleEdges.map(
          (edge) => `${edge.source}:${edge.target}:${edge.sourceHandle}:${edge.targetHandle}`,
        ),
      );
      const hiddenExistingEdges = latest.edges
        .filter(
          (edge) =>
            !visibleEdgeKeySet.has(
              `${edge.source}:${edge.target}:${edge.sourceHandle}:${edge.targetHandle}`,
            ),
        )
        .map((edge) => ({ ...edge, hidden: true }));
      const allEdges = [
        ...visibleEdges.map((edge) => ({ ...edge, hidden: false })),
        ...hiddenExistingEdges,
      ];

      set({
        graph: mergedGraph,
        nodes: allNodes,
        edges: allEdges,
        expandedTxids: nextExpanded,
        resolvedTxids: nextResolved,
        authError: null,
      });
    } catch (e) {
      if (get().handleAuthError(e)) {
        return;
      }
      throw e;
    } finally {
      set((current) => {
        if (!current.expandingTxids[txid]) return current;
        const nextExpanding = { ...current.expandingTxids };
        delete nextExpanding[txid];
        return { expandingTxids: nextExpanding };
      });
    }
  },

  triggerRelayout: () => {
    const { graph } = get();
    if (graph) {
      relayoutIfHeightsChanged(graph, get());
    }
  },
});
