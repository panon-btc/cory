import { useState, useCallback, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import type { GraphResponse } from "./types";
import { fetchGraph } from "./api";
import { computeLayout } from "./layout";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/LabelPanel";

export default function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [selectedTxid, setSelectedTxid] = useState<string | null>(null);
  const [apiToken, setApiToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastSearchRef = useRef("");

  const doSearch = useCallback(async (txid: string) => {
    lastSearchRef.current = txid;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchGraph(txid);
      const { nodes: n, edges: e } = await computeLayout(resp);
      setGraph(resp);
      setNodes(n);
      setEdges(e);
      setSelectedTxid(resp.root_txid);
    } catch (e) {
      setError((e as Error).message);
      setGraph(null);
      setNodes([]);
      setEdges([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedTxid(node.id);
  }, []);

  const handleRefresh = useCallback(() => {
    if (lastSearchRef.current) {
      doSearch(lastSearchRef.current);
    }
  }, [doSearch]);

  return (
    <ReactFlowProvider>
      <div
        style={{ display: "flex", flexDirection: "column", height: "100vh" }}
      >
        <Header
          onSearch={doSearch}
          apiToken={apiToken}
          onTokenChange={setApiToken}
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
          />
          <LabelPanel
            graph={graph}
            selectedTxid={selectedTxid}
            apiToken={apiToken}
            onRefresh={handleRefresh}
          />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
