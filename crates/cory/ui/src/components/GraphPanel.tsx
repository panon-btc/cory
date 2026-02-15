import { useMemo, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import TxNode from "./TxNode";
import { useAppStore } from "../store";

export default function GraphPanel() {
  const inputNodes = useAppStore((s) => s.nodes);
  const inputEdges = useAppStore((s) => s.edges);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const graph = useAppStore((s) => s.graph);
  const truncated = graph?.truncated ?? false;
  const stats = graph?.stats ?? null;
  const setSelectedTxid = useAppStore((s) => s.setSelectedTxid);
  const storeSetNodes = useAppStore((s) => s.setNodes);

  const nodeTypes = useMemo(() => ({ tx: TxNode }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const syncingFromPropsRef = useRef(false);

  // Keep React Flow internal state aligned with upstream store updates.
  useEffect(() => {
    syncingFromPropsRef.current = true;
    setNodes(inputNodes);
    setEdges(inputEdges);
  }, [inputNodes, inputEdges, setNodes, setEdges]);

  const minimapNodeColor = useCallback(() => "var(--accent-dim)", []);

  // When user drags nodes, push the updated positions back to the store.
  useEffect(() => {
    if (syncingFromPropsRef.current) {
      syncingFromPropsRef.current = false;
      return;
    }
    if (nodes === inputNodes) {
      return;
    }
    storeSetNodes(nodes);
  }, [nodes, inputNodes, storeSetNodes]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedTxid(node.id);
    },
    [setSelectedTxid],
  );

  if (loading) {
    return (
      <div style={{ flex: 1, padding: 20, color: "var(--text-muted)" }}>
        Loading ancestry graph...
      </div>
    );
  }

  if (error) {
    return <div style={{ flex: 1, padding: 20, color: "var(--accent)" }}>Error: {error}</div>;
  }

  if (!graph) {
    return (
      <div style={{ flex: 1, padding: 20, color: "var(--text-muted)" }}>
        Enter a transaction ID above to explore its ancestry.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, position: "relative" }}>
      {stats && (
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            zIndex: 5,
            color: "var(--text-muted)",
            fontSize: 11,
            fontFamily: "var(--mono)",
          }}
        >
          {stats.node_count} transactions, {stats.edge_count} edges, max depth{" "}
          {stats.max_depth_reached}
          {truncated && <span style={{ color: "var(--warning)", marginLeft: 8 }}>(truncated)</span>}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodesDraggable={true}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Controls />
        <MiniMap nodeColor={minimapNodeColor} maskColor="rgba(0, 0, 0, 0.6)" />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
