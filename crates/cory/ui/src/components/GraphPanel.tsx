import { useMemo, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useNodesInitialized,
} from "@xyflow/react";
import type { NodeChange, EdgeChange, NodeProps } from "@xyflow/react";
import toast from "react-hot-toast";
import TxNode from "./TxNode/TxNode";
import { useAppStore } from "../store/AppStore";
import type { TxFlowNode } from "../graph/Layout";

function hasExpandableInputs(
  graph: ReturnType<typeof useAppStore.getState>["graph"],
  txid: string,
): boolean {
  const sourceNode = graph?.nodes[txid];
  return sourceNode ? sourceNode.inputs.some((input) => input.prevout !== null) : false;
}

// Controlled React Flow: the Zustand store is the single source of truth
// for nodes and edges. User interactions (drags, selections) flow through
// onNodesChange/onEdgesChange, which apply changes to the store directly.
// This eliminates the previous two-state sync pattern (useNodesState +
// useEffect + syncingFromPropsRef) that was fragile and order-dependent.
export default function GraphPanel() {
  const { setCenter, fitView } = useReactFlow();
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
  const setHasUserMovedNodes = useAppStore((s) => s.setHasUserMovedNodes);
  const toggleNodeInputs = useAppStore((s) => s.toggleNodeInputs);
  const expandingTxids = useAppStore((s) => s.expandingTxids);
  const expandedTxids = useAppStore((s) => s.expandedTxids);
  const searchFocusRequestId = useAppStore((s) => s.searchFocusRequestId);
  const searchFocusTxid = useAppStore((s) => s.searchFocusTxid);
  const lastCenteredFocusRequestIdRef = useRef(0);
  const nodesInitialized = useNodesInitialized();

  const handleCopied = useCallback((value: string) => {
    toast(`Copied ${value} to clipboard`, { id: "clipboard-copy-toast" });
  }, []);

  const nodeTypes = useMemo(
    () => ({
      tx: (props: NodeProps<TxFlowNode>) => {
        const canExpand = hasExpandableInputs(graph, props.id);
        const isExpanded = Boolean(expandedTxids[props.id]);
        return (
          <TxNode
            {...props}
            onCopied={handleCopied}
            onToggleExpand={(txid) => void toggleNodeInputs(txid)}
            expandMode={isExpanded ? "collapse" : "expand"}
            toggleDisabled={loading || (!canExpand && !isExpanded)}
            toggleLoading={Boolean(expandingTxids[props.id])}
          />
        );
      },
    }),
    [expandedTxids, expandingTxids, graph, handleCopied, loading, toggleNodeInputs],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<TxFlowNode>[]) => {
      if (changes.some((change) => change.type === "position")) {
        setHasUserMovedNodes(true);
      }
      setNodes((prev) => applyNodeChanges(changes, prev));
    },
    [setHasUserMovedNodes, setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((prev) => applyEdgeChanges(changes, prev));
    },
    [setEdges],
  );

  const minimapNodeColor = useCallback(() => "var(--accent)", []);

  // After each successful search, center the searched txid and select it.
  // This runs once per search completion (guarded by request id), not on
  // subsequent drags/edits.
  useEffect(() => {
    if (!nodesInitialized) return;
    if (!searchFocusTxid) return;
    if (searchFocusRequestId === 0) return;
    if (lastCenteredFocusRequestIdRef.current === searchFocusRequestId) return;

    const node = nodes.find((n) => n.id === searchFocusTxid);
    if (!node) return;

    const width = typeof node.style?.width === "number" ? node.style.width : 0;
    const height = typeof node.style?.height === "number" ? node.style.height : 0;
    const centerX = node.position.x + width / 2;
    const centerY = node.position.y + height / 2;

    setSelectedTxid(searchFocusTxid);
    void fitView({
      nodes: [{ id: searchFocusTxid }],
      duration: 300,
      padding: 0.35,
      includeHiddenNodes: true,
    });
    setCenter(centerX, centerY, { duration: 300 });
    lastCenteredFocusRequestIdRef.current = searchFocusRequestId;
  }, [
    fitView,
    nodes,
    nodesInitialized,
    searchFocusRequestId,
    searchFocusTxid,
    setCenter,
    setSelectedTxid,
  ]);

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
    return (
      <div style={{ flex: 1, padding: 20 }} className="text-error">
        Error: {error}
      </div>
    );
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
          className="stats-chip"
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            zIndex: 5,
            color: "var(--text-secondary)",
            fontSize: 11,
            fontFamily: "var(--mono)",
            maxWidth: "calc(100% - 20px)",
          }}
        >
          {stats.node_count} transactions, {stats.edge_count} edges, max depth{" "}
          {stats.max_depth_reached}
          {truncated && (
            <span className="text-warning" style={{ marginLeft: 8 }}>
              (truncated)
            </span>
          )}
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
        <MiniMap nodeColor={minimapNodeColor} maskColor="var(--overlay-mask)" />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
