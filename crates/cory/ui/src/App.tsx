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
import {
  deleteLabelInFile,
  fetchGraph,
  fetchLabelFiles,
  initializeAuth,
  setLabelInFile,
  SessionExpiredError,
} from "./api";
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
  const [authReady, setAuthReady] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [selectedTxid, setSelectedTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [labelFiles, setLabelFiles] = useState<LabelFileSummary[]>([]);
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

  // Helper to check if an error is a session expiration
  const handlePossibleSessionExpiry = useCallback((e: unknown): boolean => {
    if (e instanceof SessionExpiredError) {
      setSessionExpired(true);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    labelFilesRef.current = labelFiles;
  }, [labelFiles]);

  // Initialize authentication before any API calls can be made.
  // This ensures the access token is acquired before other effects run.
  useEffect(() => {
    let mounted = true;
    initializeAuth()
      .then(() => {
        if (mounted) setAuthReady(true);
      })
      .catch((err) => {
        console.error("Authentication initialization failed:", err);
        // Still mark as ready so the app can attempt recovery on API calls
        if (mounted) setAuthReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

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
    } catch (e) {
      // Session expired - propagate for handling
      if (handlePossibleSessionExpiry(e)) {
        return labelFilesRef.current;
      }
      // Keep current list if label file metadata request fails.
      return labelFilesRef.current;
    }
  }, [handlePossibleSessionExpiry]);

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

        // Session expired - show session expired screen
        if (handlePossibleSessionExpiry(e)) return;

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
    [handlePossibleSessionExpiry],
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

  // Only fetch label files after auth is ready to avoid 401 errors
  useEffect(() => {
    if (authReady) {
      void refreshLabelFiles();
    }
  }, [authReady, refreshLabelFiles]);

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

  // Show loading state while authentication is initializing
  if (!authReady) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--muted-foreground)",
        }}
      >
        Initializing...
      </div>
    );
  }

  // Show session expired screen when refresh token is invalid/expired
  if (sessionExpired) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: "1rem",
          color: "var(--foreground)",
        }}
      >
        <h2 style={{ margin: 0 }}>Session Expired</h2>
        <p style={{ margin: 0, color: "var(--muted-foreground)" }}>
          Your session has expired. Please refresh the page to continue in a new session.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            border: "1px solid var(--border)",
            background: "var(--primary)",
            color: "var(--primary-foreground)",
            cursor: "pointer",
          }}
        >
          Refresh Page
        </button>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Header onSearch={doSearch} />
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
