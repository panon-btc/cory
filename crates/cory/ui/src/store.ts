// ==============================================================================
// Zustand Store
// ==============================================================================
//
// Central state store. Store methods are inherently stable references and
// live outside React's render cycle, eliminating stale-closure problems.

import { create } from "zustand";
import type { Edge } from "@xyflow/react";
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
