import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import type { NodeChange, EdgeChange } from "@xyflow/react";
import TxNode from "./txnode/Node";
import { useAppStore } from "../store";
import type { TxFlowNode } from "../layout";

// Controlled React Flow: the Zustand store is the single source of truth
// for nodes and edges. User interactions (drags, selections) flow through
// onNodesChange/onEdgesChange, which apply changes to the store directly.
// This eliminates the previous two-state sync pattern (useNodesState +
// useEffect + syncingFromPropsRef) that was fragile and order-dependent.
export default function GraphPanel() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const graph = useAppStore((s) => s.graph);
  const truncated = graph?.truncated ?? false;
  const stats = graph?.stats ?? null;
  const setSelectedTxid = useAppStore((s) => s.setSelectedTxid);
  const setNodes = useAppStore((s) => s.setNodes);
  const setEdges = useAppStore((s) => s.setEdges);

  const nodeTypes = useMemo(() => ({ tx: TxNode }), []);

  const onNodesChange = useCallback(
    (changes: NodeChange<TxFlowNode>[]) => {
      setNodes((prev) => applyNodeChanges(changes, prev));
    },
    [setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((prev) => applyEdgeChanges(changes, prev));
    },
    [setEdges],
  );

  const minimapNodeColor = useCallback(() => "var(--accent-dim)", []);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: TxFlowNode) => {
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
