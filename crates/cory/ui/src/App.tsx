import { useState, useCallback, useRef, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import type { GraphResponse, LabelFileSummary } from "./types";
import {
  deleteLabelInFile,
  fetchGraph,
  fetchLabelFiles,
  initializeAuth,
  setLabelInFile,
} from "./api";
import { computeLayout, type TxNodeData } from "./layout";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/LabelPanel";

export default function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [selectedTxid, setSelectedTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [labelFiles, setLabelFiles] = useState<LabelFileSummary[]>([]);
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
    (fileId: string, fileName: string, txid: string, label: string) => {
      setGraph((prev) => {
        if (!prev) return prev;
        const nextLabels = { ...prev.labels };
        const existing = [...(nextLabels[txid] ?? [])];
        const idx = existing.findIndex((entry) => entry.file_id === fileId);
        if (idx >= 0) {
          existing[idx] = {
            file_id: fileId,
            file_name: fileName,
            file_kind: "local",
            editable: true,
            label,
          };
        } else {
          existing.push({
            file_id: fileId,
            file_name: fileName,
            file_kind: "local",
            editable: true,
            label,
          });
        }
        nextLabels[txid] = existing;
        return { ...prev, labels: nextLabels };
      });

      setNodes((prevNodes) =>
        prevNodes.map((node) => {
          if (node.id !== txid) return node;
          const data = node.data as TxNodeData;
          const existing = [...data.labels];
          const idx = existing.findIndex((entry) => entry.file_id === fileId);
          if (idx >= 0) {
            existing[idx] = {
              file_id: fileId,
              file_name: fileName,
              file_kind: "local",
              editable: true,
              label,
            };
          } else {
            existing.push({
              file_id: fileId,
              file_name: fileName,
              file_kind: "local",
              editable: true,
              label,
            });
          }
          return {
            ...node,
            data: {
              ...data,
              labels: existing,
            },
          };
        }),
      );
    },
    [],
  );

  const removeLabelFromState = useCallback((fileId: string, txid: string) => {
    setGraph((prev) => {
      if (!prev) return prev;
      const nextLabels = { ...prev.labels };
      const existing = nextLabels[txid] ?? [];
      nextLabels[txid] = existing.filter((entry) => entry.file_id !== fileId);
      return { ...prev, labels: nextLabels };
    });

    setNodes((prevNodes) =>
      prevNodes.map((node) => {
        if (node.id !== txid) return node;
        const data = node.data as TxNodeData;
        return {
          ...node,
          data: {
            ...data,
            labels: data.labels.filter((entry) => entry.file_id !== fileId),
          },
        };
      }),
    );
  }, []);

  const refreshLabelFiles = useCallback(async (): Promise<
    LabelFileSummary[]
  > => {
    try {
      const files = await fetchLabelFiles();
      const onlyLocal = files.filter((file) => file.kind === "local");
      setLabelFiles(onlyLocal);
      return onlyLocal;
    } catch {
      // Keep current list if label file metadata request fails.
      return labelFilesRef.current;
    }
  }, []);

  const handleNodeLabelSave = useCallback(
    async (fileId: string, txid: string, label: string): Promise<void> => {
      const summary = await setLabelInFile(fileId, txid, label);
      upsertLabelInState(fileId, summary.name, txid, label);
      await refreshLabelFiles();
    },
    [refreshLabelFiles, upsertLabelInState],
  );

  const handleNodeLabelDelete = useCallback(
    async (fileId: string, txid: string): Promise<void> => {
      await deleteLabelInFile(fileId, txid);
      removeLabelFromState(fileId, txid);
      await refreshLabelFiles();
    },
    [removeLabelFromState, refreshLabelFiles],
  );

  const doSearch = useCallback(
    async (
      txid: string,
      opts?: {
        preserveSelectedTxid?: string | null;
        quietErrors?: boolean;
        localFilesOverride?: LabelFileSummary[];
      },
    ) => {
      lastSearchRef.current = txid;
      setLoading(true);
      setError(null);
      try {
        const localFilesForLayout = opts?.localFilesOverride ?? labelFiles;
        const resp = await fetchGraph(txid);
        const { nodes: n, edges: e } = await computeLayout(resp, {
          localFiles: localFilesForLayout,
          onSaveLabel: handleNodeLabelSave,
          onDeleteLabel: handleNodeLabelDelete,
        });
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
    [labelFiles, handleNodeLabelSave, handleNodeLabelDelete],
  );

  useEffect(() => {
    void refreshLabelFiles();
  }, [refreshLabelFiles]);

  useEffect(() => {
    setNodes((prevNodes) =>
      prevNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          localFiles: labelFiles,
          onSaveLabel: handleNodeLabelSave,
          onDeleteLabel: handleNodeLabelDelete,
        },
      })),
    );
  }, [labelFiles, handleNodeLabelSave, handleNodeLabelDelete]);

  const handleNodesUpdate = useCallback((nextNodes: Node[]) => {
    setNodes(nextNodes);
  }, []);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedTxid(node.id);
  }, []);

  const handleLabelsChanged = useCallback(
    async (opts?: { refreshGraph?: boolean }) => {
      const freshFiles = await refreshLabelFiles();
      if (opts?.refreshGraph === false) {
        return;
      }
      if (lastSearchRef.current) {
        await doSearch(lastSearchRef.current, {
          preserveSelectedTxid: selectedTxid,
          quietErrors: true,
          localFilesOverride: freshFiles,
        });
      }
    },
    [doSearch, refreshLabelFiles, selectedTxid],
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
          <LabelPanel
            labelFiles={labelFiles}
            onLabelsChanged={handleLabelsChanged}
          />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
