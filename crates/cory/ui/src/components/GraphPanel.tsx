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
import type { Node, Edge, NodeMouseHandler } from "@xyflow/react";
import TxNode from "./TxNode";

interface GraphPanelProps {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
  error: string | null;
  hasGraph: boolean;
  truncated: boolean;
  stats: {
    node_count: number;
    edge_count: number;
    max_depth_reached: number;
  } | null;
  onNodeClick: NodeMouseHandler;
  onNodesUpdate: (nodes: Node[]) => void;
}

export default function GraphPanel({
  nodes: inputNodes,
  edges: inputEdges,
  loading,
  error,
  hasGraph,
  truncated,
  stats,
  onNodeClick,
  onNodesUpdate,
}: GraphPanelProps) {
  const nodeTypes = useMemo(() => ({ tx: TxNode }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const syncingFromPropsRef = useRef(false);

  // Keep React Flow internal state aligned with upstream graph updates.
  useEffect(() => {
    syncingFromPropsRef.current = true;
    setNodes(inputNodes);
    setEdges(inputEdges);
  }, [inputNodes, inputEdges, setNodes, setEdges]);

  const minimapNodeColor = useCallback(() => "var(--accent-dim)", []);

  useEffect(() => {
    if (syncingFromPropsRef.current) {
      syncingFromPropsRef.current = false;
      return;
    }
    if (nodes === inputNodes) {
      return;
    }
    onNodesUpdate(nodes);
  }, [nodes, inputNodes, onNodesUpdate]);

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

  if (!hasGraph) {
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
        onNodeClick={onNodeClick}
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
