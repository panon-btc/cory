import { useState, useCallback, useRef, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import type {
  Bip329Type,
  GraphResponse,
  LabelEntry,
  LabelFileSummary,
  LabelsByType,
} from "./types";
import { deleteLabelInFile, fetchGraph, fetchLabelFiles, setApiToken, setLabelInFile } from "./api";
import { computeLayout, refreshNodesFromGraph } from "./layout";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/LabelPanel";

function editableLabelBucket(
  labels: LabelsByType,
  labelType: Bip329Type,
): Record<string, LabelEntry[]> | null {
  if (labelType === "tx") return labels.tx;
  if (labelType === "input") return labels.input;
  if (labelType === "output") return labels.output;
  if (labelType === "addr") return labels.addr;
  return null;
}

export default function App() {
  const SIDEBAR_MIN_WIDTH = 320;
  const SIDEBAR_MAX_WIDTH = 960;
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
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem("cory:sidebarWidth");
    if (stored) {
      const n = parseInt(stored, 10);
      if (!isNaN(n) && n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) return n;
    }
    return 390;
  });
  const lastSearchRef = useRef("");
  const labelFilesRef = useRef<LabelFileSummary[]>([]);
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
      setGraph((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          labels_by_type: {
            tx: { ...prev.labels_by_type.tx },
            input: { ...prev.labels_by_type.input },
            output: { ...prev.labels_by_type.output },
            addr: { ...prev.labels_by_type.addr },
          },
        };

        const bucket = editableLabelBucket(next.labels_by_type, labelType);
        if (!bucket) {
          return prev;
        }

        const existing = [...(bucket[refId] ?? [])];
        const idx = existing.findIndex((entry) => entry.file_id === fileId);
        const row: LabelEntry = {
          file_id: fileId,
          file_name: fileName,
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

        return next;
      });
    },
    [],
  );

  const removeLabelFromState = useCallback(
    (fileId: string, labelType: Bip329Type, refId: string) => {
      setGraph((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          labels_by_type: {
            tx: { ...prev.labels_by_type.tx },
            input: { ...prev.labels_by_type.input },
            output: { ...prev.labels_by_type.output },
            addr: { ...prev.labels_by_type.addr },
          },
        };

        const bucket = editableLabelBucket(next.labels_by_type, labelType);
        if (!bucket) {
          return prev;
        }

        const existing = bucket[refId] ?? [];
        bucket[refId] = existing.filter((entry) => entry.file_id !== fileId);
        return next;
      });
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

  useEffect(() => {
    if (!graph) {
      return;
    }
    setNodes((prevNodes) => {
      const nextNodes = refreshNodesFromGraph(graph, prevNodes);

      // If any node height changed (e.g. from label edits), rerun ELK
      // layout so nodes don't overlap. We compare heights from the
      // previous render to detect growth/shrinkage.
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

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth - deltaX));
        setSidebarWidth(next);
      };

      const onMouseUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        const finalWidth = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth - (upEvent.clientX - startX)),
        );
        localStorage.setItem("cory:sidebarWidth", String(finalWidth));
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [sidebarWidth],
  );

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
