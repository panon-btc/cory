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
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [selectedTxid, setSelectedTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [labelFiles, setLabelFiles] = useState<LabelFileSummary[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(390);
  const lastSearchRef = useRef("");
  const labelFilesRef = useRef<LabelFileSummary[]>([]);

  useEffect(() => {
    labelFilesRef.current = labelFiles;
  }, [labelFiles]);

  useEffect(() => {
    void initializeAuth().catch((err) => {
      console.error("Authentication initialization failed:", err);
    });
  }, []);

  const upsertLabelInState = useCallback(
    (
      fileId: string,
      fileName: string,
      labelType: Bip329Type,
      refId: string,
      label: string,
    ) => {
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

  const refreshLabelFiles = useCallback(async (): Promise<
    LabelFileSummary[]
  > => {
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
      lastSearchRef.current = txid;
      setLoading(true);
      setError(null);
      try {
        const resp = await fetchGraph(txid);
        const { nodes: n, edges: e } = await computeLayout(resp);
        const preservedTxid = opts?.preserveSelectedTxid;
        const nextSelectedTxid =
          preservedTxid && resp.nodes[preservedTxid]
            ? preservedTxid
            : resp.root_txid;

        setGraph(resp);
        setNodes(n);
        setEdges(e);
        setSelectedTxid(nextSelectedTxid);
      } catch (e) {
        if (!opts?.quietErrors) {
          setError((e as Error).message);
          setGraph(null);
          setNodes([]);
          setEdges([]);
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const handleSaveLabel = useCallback(
    async (
      fileId: string,
      labelType: Bip329Type,
      refId: string,
      label: string,
  ): Promise<void> => {
      const summary = await setLabelInFile(fileId, labelType, refId, label);
      upsertLabelInState(fileId, summary.name, labelType, refId, label);
      await refreshLabelFiles();
    },
    [refreshLabelFiles, upsertLabelInState],
  );

  const handleDeleteLabel = useCallback(
    async (
      fileId: string,
      labelType: Bip329Type,
      refId: string,
  ): Promise<void> => {
      await deleteLabelInFile(fileId, labelType, refId);
      removeLabelFromState(fileId, labelType, refId);
      await refreshLabelFiles();
    },
    [refreshLabelFiles, removeLabelFromState],
  );

  useEffect(() => {
    void refreshLabelFiles();
  }, [refreshLabelFiles]);

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
    setNodes((prevNodes) => refreshNodesFromGraph(graph, prevNodes));
  }, [graph]);

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const next = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth - deltaX),
        );
        setSidebarWidth(next);
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [sidebarWidth],
  );

  return (
    <ReactFlowProvider>
      <div
        style={{ display: "flex", flexDirection: "column", height: "100vh" }}
      >
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
