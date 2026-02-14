import { useState, useCallback, useRef, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import type { Bip329Type, GraphResponse, LabelFileSummary } from "./types";
import { deleteLabelInFile, fetchGraph, fetchLabelFiles, setApiToken, setLabelInFile } from "./api";
import { computeLayout, refreshNodesFromGraph } from "./layout";
import { upsertLabel, removeLabel } from "./labels";
import { useSidebarResize } from "./hooks/useSidebarResize";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/LabelPanel";

export default function App() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialSearch = initialParams.get("search")?.trim() ?? "";
  const initialToken = initialParams.get("token")?.trim() ?? "";
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [selectedTxid, setSelectedTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [labelFiles, setLabelFiles] = useState<LabelFileSummary[]>([]);
  const [apiToken, setApiTokenState] = useState(
    () => initialToken || localStorage.getItem("cory:apiToken") || "",
  );
  const [searchParamTxid, setSearchParamTxid] = useState(initialSearch);
  const { width: sidebarWidth, onResizeStart: handleSidebarResizeStart } = useSidebarResize();
  const lastSearchRef = useRef("");
  const labelFilesRef = useRef<LabelFileSummary[]>([]);

  // Race-condition guard for fast typing: `searchAbortRef` cancels the
  // in-flight HTTP request, while `searchIdRef` discards results that
  // arrive after a newer search has already started. Both are needed
  // because AbortController only cancels the fetch, not the subsequent
  // ELK layout computation.
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchIdRef = useRef(0);
  const ranInitialSearchRef = useRef(false);

  const replaceUrlParams = useCallback((token: string, search: string) => {
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
  }, []);

  useEffect(() => {
    labelFilesRef.current = labelFiles;
  }, [labelFiles]);

  useEffect(() => {
    localStorage.setItem("cory:apiToken", apiToken);
    setApiToken(apiToken);
    replaceUrlParams(apiToken, searchParamTxid);
  }, [apiToken, replaceUrlParams, searchParamTxid]);

  const upsertLabelInState = useCallback(
    (fileId: string, fileName: string, labelType: Bip329Type, refId: string, label: string) => {
      setGraph((prev) =>
        prev ? upsertLabel(prev, fileId, fileName, labelType, refId, label) : prev,
      );
    },
    [],
  );

  const removeLabelFromState = useCallback(
    (fileId: string, labelType: Bip329Type, refId: string) => {
      setGraph((prev) => (prev ? removeLabel(prev, fileId, labelType, refId) : prev));
    },
    [],
  );

  const refreshLabelFiles = useCallback(async (): Promise<LabelFileSummary[]> => {
    try {
      const files = await fetchLabelFiles();
      setLabelFiles(files);
      return files;
    } catch {
      // Keep current list if label file metadata request fails.
      return labelFilesRef.current;
    }
  }, []);

  const doSearch = useCallback(
    async (
      txid: string,
      opts?: {
        preserveSelectedTxid?: string | null;
        quietErrors?: boolean;
      },
    ) => {
      // Abort any in-flight search request so we don't apply stale results.
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const thisSearchId = ++searchIdRef.current;

      lastSearchRef.current = txid;
      setSearchParamTxid(txid);
      setLoading(true);
      setError(null);
      try {
        const resp = await fetchGraph(txid, controller.signal);
        const { nodes: n, edges: e } = await computeLayout(resp);

        // Guard: if another search was started while we were awaiting,
        // discard these results silently.
        if (searchIdRef.current !== thisSearchId) return;

        const preservedTxid = opts?.preserveSelectedTxid;
        const nextSelectedTxid =
          preservedTxid && resp.nodes[preservedTxid] ? preservedTxid : resp.root_txid;

        setGraph(resp);
        setNodes(n);
        setEdges(e);
        setSelectedTxid(nextSelectedTxid);
      } catch (e) {
        // Aborted requests are not errors — just ignore them.
        if ((e as Error).name === "AbortError") return;
        if (searchIdRef.current !== thisSearchId) return;

        if (!opts?.quietErrors) {
          setError((e as Error).message);
          setGraph(null);
          setNodes([]);
          setEdges([]);
        }
      } finally {
        if (searchIdRef.current === thisSearchId) {
          setLoading(false);
        }
      }
    },
    [],
  );

  const handleSaveLabel = useCallback(
    async (fileId: string, labelType: Bip329Type, refId: string, label: string): Promise<void> => {
      const summary = await setLabelInFile(fileId, labelType, refId, label);
      upsertLabelInState(fileId, summary.name, labelType, refId, label);
      await refreshLabelFiles();
    },
    [refreshLabelFiles, upsertLabelInState],
  );

  const handleDeleteLabel = useCallback(
    async (fileId: string, labelType: Bip329Type, refId: string): Promise<void> => {
      await deleteLabelInFile(fileId, labelType, refId);
      removeLabelFromState(fileId, labelType, refId);
      await refreshLabelFiles();
    },
    [refreshLabelFiles, removeLabelFromState],
  );

  useEffect(() => {
    void refreshLabelFiles();
  }, [refreshLabelFiles]);

  useEffect(() => {
    if (ranInitialSearchRef.current) return;
    ranInitialSearchRef.current = true;
    if (initialSearch) {
      void doSearch(initialSearch);
    }
  }, [doSearch, initialSearch]);

  const handleNodesUpdate = useCallback((nextNodes: Node[]) => {
    setNodes(nextNodes);
  }, []);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedTxid(node.id);
  }, []);

  const handleLabelsChanged = useCallback(
    async (opts?: { refreshGraph?: boolean }) => {
      await refreshLabelFiles();
      if (opts?.refreshGraph === false) {
        return;
      }
      if (lastSearchRef.current) {
        await doSearch(lastSearchRef.current, {
          preserveSelectedTxid: selectedTxid,
          quietErrors: true,
        });
      }
    },
    [doSearch, refreshLabelFiles, selectedTxid],
  );

  // Label edits change node heights (more label lines = taller node)
  // without changing the graph topology. We detect height changes and
  // rerun ELK layout so nodes don't overlap after growing/shrinking.
  useEffect(() => {
    if (!graph) {
      return;
    }
    setNodes((prevNodes) => {
      const nextNodes = refreshNodesFromGraph(graph, prevNodes);

      const heightChanged = nextNodes.some((node, i) => {
        const prev = prevNodes[i];
        if (!prev || prev.id !== node.id) return true;
        const prevH = (prev.style?.height as number | undefined) ?? 0;
        const nextH = (node.style?.height as number | undefined) ?? 0;
        return prevH !== nextH;
      });

      if (heightChanged) {
        void computeLayout(graph).then(({ nodes: n, edges: e }) => {
          setNodes(n);
          setEdges(e);
        });
      }

      return nextNodes;
    });
  }, [graph]);

  return (
    <ReactFlowProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Header
          onSearch={doSearch}
          apiToken={apiToken}
          onTokenChange={setApiTokenState}
          initialTxid={initialSearch}
        />
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <GraphPanel
            nodes={nodes}
            edges={edges}
            loading={loading}
            error={error}
            hasGraph={graph !== null}
            truncated={graph?.truncated ?? false}
            stats={graph?.stats ?? null}
            onNodeClick={handleNodeClick}
            onNodesUpdate={handleNodesUpdate}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleSidebarResizeStart}
            style={{
              width: 6,
              cursor: "col-resize",
              background: "var(--border)",
              opacity: 0.45,
            }}
            title="Drag to resize panel"
          />
          <LabelPanel
            width={sidebarWidth}
            labelFiles={labelFiles}
            graph={graph}
            selectedTxid={selectedTxid}
            onLabelsChanged={handleLabelsChanged}
            onSaveLabel={handleSaveLabel}
            onDeleteLabel={handleDeleteLabel}
          />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
