// ==============================================================================
// Zustand Store
// ==============================================================================
//
// Central state store that replaces the useCallback/useRef boilerplate in
// App.tsx and the pure mutation helpers in labels.ts. Store methods are
// inherently stable references and live outside React's render cycle,
// eliminating stale-closure problems.

import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import type {
  Bip329Type,
  GraphResponse,
  LabelEntry,
  LabelFileSummary,
  LabelsByType,
} from "./types";
import {
  deleteLabelInFile,
  fetchGraph,
  fetchLabelFiles,
  setApiToken as setApiTokenInModule,
  setLabelInFile,
} from "./api";
import { computeLayout, refreshNodesFromGraph } from "./layout";

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

function replaceUrlParams(token: string, search: string): void {
  const tokenTrimmed = token.trim();
  const searchTrimmed = search.trim();
  const parts: string[] = [];

  // Keep token first whenever both params are present.
  if (tokenTrimmed) {
    parts.push(`token=${encodeURIComponent(tokenTrimmed)}`);
  }
  if (searchTrimmed) {
    parts.push(`search=${encodeURIComponent(searchTrimmed)}`);
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
  nodes: Node[];
  edges: Edge[];
  graph: GraphResponse | null;
  selectedTxid: string | null;
  loading: boolean;
  error: string | null;

  // Labels
  labelFiles: LabelFileSummary[];

  // API token (persisted to localStorage + URL)
  apiToken: string;

  // Search URL param tracked for URL sync.
  searchParamTxid: string;

  // Actions
  doSearch: (
    txid: string,
    opts?: { preserveSelectedTxid?: string | null; quietErrors?: boolean },
  ) => Promise<void>;
  setSelectedTxid: (txid: string | null) => void;
  setNodes: (updater: Node[] | ((prev: Node[]) => Node[])) => void;
  setEdges: (edges: Edge[]) => void;
  setApiToken: (token: string) => void;
  refreshLabelFiles: () => Promise<LabelFileSummary[]>;
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
  labelFiles: [],
  apiToken: "",
  searchParamTxid: "",

  setSelectedTxid: (txid) => set({ selectedTxid: txid }),

  setNodes: (updater) =>
    set((state) => ({
      nodes: typeof updater === "function" ? updater(state.nodes) : updater,
    })),

  setEdges: (edges) => set({ edges }),

  setApiToken: (token) => {
    set({ apiToken: token });
    localStorage.setItem("cory:apiToken", token);
    setApiTokenInModule(token);
    replaceUrlParams(token, get().searchParamTxid);
  },

  refreshLabelFiles: async () => {
    try {
      const files = await fetchLabelFiles();
      set({ labelFiles: files });
      return files;
    } catch {
      // Keep current list if label file metadata request fails.
      return get().labelFiles;
    }
  },

  doSearch: async (txid, opts) => {
    // Abort any in-flight search request so we don't apply stale results.
    searchAbortController?.abort();
    const controller = new AbortController();
    searchAbortController = controller;
    const thisSearchId = ++searchId;

    lastSearchTxid = txid;
    set({ searchParamTxid: txid, loading: true, error: null });
    replaceUrlParams(get().apiToken, txid);

    try {
      const resp = await fetchGraph(txid, controller.signal);
      const { nodes: n, edges: e } = await computeLayout(resp);

      // Guard: if another search was started while we were awaiting,
      // discard these results silently.
      if (searchId !== thisSearchId) return;

      const preservedTxid = opts?.preserveSelectedTxid;
      const nextSelectedTxid =
        preservedTxid && resp.nodes[preservedTxid] ? preservedTxid : resp.root_txid;

      set({ graph: resp, nodes: n, edges: e, selectedTxid: nextSelectedTxid });
    } catch (e) {
      // Aborted requests are not errors — just ignore them.
      if ((e as Error).name === "AbortError") return;
      if (searchId !== thisSearchId) return;

      if (!opts?.quietErrors) {
        set({
          error: (e as Error).message,
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
    const summary = await setLabelInFile(fileId, labelType, refId, label);

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
      const row: LabelEntry = {
        file_id: fileId,
        file_name: summary.name,
        file_kind: "local",
        editable: true,
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
    await deleteLabelInFile(fileId, labelType, refId);

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
  const { nodes: prevNodes, setNodes, setEdges } = useAppStore.getState();
  const nextNodes = refreshNodesFromGraph(graph, prevNodes);

  const heightChanged = nextNodes.some((node, i) => {
    const prev = prevNodes[i];
    if (!prev || prev.id !== node.id) return true;
    const prevH = (prev.style?.height as number | undefined) ?? 0;
    const nextH = (node.style?.height as number | undefined) ?? 0;
    return prevH !== nextH;
  });

  setNodes(nextNodes);

  if (heightChanged) {
    void computeLayout(graph).then(({ nodes: n, edges: e }) => {
      setNodes(n);
      setEdges(e);
    });
  }
}
