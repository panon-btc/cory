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
import type { NodeChange, EdgeChange, NodeProps, NodePositionChange } from "@xyflow/react";
import toast from "react-hot-toast";
import TxNode from "./TxNode/TxNode";
import { useAppStore } from "../store/AppStore";
import type { TxFlowNode } from "../graph/Layout";
import { computeAllAncestors } from "../graph/GraphUtils";

function hasExpandableInputs(
  graph: ReturnType<typeof useAppStore.getState>["graph"],
  txid: string,
): boolean {
  const sourceNode = graph?.nodes[txid];
  return sourceNode ? sourceNode.inputs.some((input) => input.prevout !== null) : false;
}

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
  const collapseNode = useAppStore((s) => s.collapseNode);
  const expandingTxids = useAppStore((s) => s.expandingTxids);
  const expandedTxids = useAppStore((s) => s.expandedTxids);
  const hiddenTxids = useAppStore((s) => s.hiddenTxids);
  const searchFocusRequestId = useAppStore((s) => s.searchFocusRequestId);
  const searchFocusTxid = useAppStore((s) => s.searchFocusTxid);
  const lastCenteredFocusRequestIdRef = useRef(0);
  const nodesInitialized = useNodesInitialized();

  // Track the Ctrl key status to enable recursive node movement.
  const ctrlKeyRef = useRef(false);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      ctrlKeyRef.current = e.ctrlKey;
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
    };
  }, []);

  const handleCopied = useCallback((value: string) => {
    toast(`Copied ${value} to clipboard`, { id: "clipboard-copy-toast" });
  }, []);

  const nodeTypes = useMemo(
    () => ({
      tx: (props: NodeProps<TxFlowNode>) => {
        const canExpand = hasExpandableInputs(graph, props.id);
        const isExpanded = Boolean(expandedTxids[props.id]);

        const inputs = graph?.nodes[props.id]?.inputs ?? [];
        const hasHiddenInputs = inputs.some((input) => {
          const tid = input.prevout?.split(":")[0];
          return tid && hiddenTxids[tid];
        });

        const expandMode = !isExpanded || hasHiddenInputs ? "expand" : "collapse";

        return (
          <TxNode
            {...props}
            onCopied={handleCopied}
            onToggleExpand={(txid) => void toggleNodeInputs(txid)}
            onCollapseNode={(txid) => collapseNode(txid)}
            isRoot={props.id === graph?.root_txid}
            expandMode={expandMode}
            toggleDisabled={loading || (!canExpand && expandMode === "expand" && !hasHiddenInputs)}
            toggleLoading={Boolean(expandingTxids[props.id])}
          />
        );
      },
    }),
    [
      expandedTxids,
      expandingTxids,
      graph,
      handleCopied,
      collapseNode,
      loading,
      toggleNodeInputs,
      hiddenTxids,
    ],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<TxFlowNode>[]) => {
      const isPositionChange = changes.some((change) => change.type === "position");
      if (isPositionChange) {
        setHasUserMovedNodes(true);
      }

      let allChanges = [...changes];

      // If dragging with Ctrl held, recursively apply the same position delta to all ancestors.
      const firstChange = changes[0];
      if (
        ctrlKeyRef.current &&
        graph &&
        changes.length === 1 &&
        firstChange?.type === "position" &&
        firstChange.dragging
      ) {
        const primaryChange = firstChange as NodePositionChange;
        const primaryNode = nodes.find((n) => n.id === primaryChange.id);

        if (primaryNode && primaryChange.position) {
          const deltaX = primaryChange.position.x - primaryNode.position.x;
          const deltaY = primaryChange.position.y - primaryNode.position.y;

          if (deltaX !== 0 || deltaY !== 0) {
            const ancestorIds = computeAllAncestors(graph, primaryNode.id);

            for (const ancestorId of ancestorIds) {
              const ancestorNode = nodes.find((n) => n.id === ancestorId);
              if (ancestorNode) {
                allChanges.push({
                  id: ancestorId,
                  type: "position",
                  dragging: true,
                  position: {
                    x: ancestorNode.position.x + deltaX,
                    y: ancestorNode.position.y + deltaY,
                  },
                });
              }
            }
          }
        }
      }

      setNodes((prev) => applyNodeChanges(allChanges, prev));
    },
    [setHasUserMovedNodes, setNodes, graph, nodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((prev) => applyEdgeChanges(changes, prev));
    },
    [setEdges],
  );

  const minimapNodeColor = useCallback(() => "var(--accent)", []);

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
        <div className="controls-legend">
          <div>
            <b>Shift + Drag</b>: Box-select multiple nodes
          </div>
          <div>
            <b>Ctrl + Click</b>: Select multiple nodes one-by-one
          </div>
          <div>
            <b>Ctrl + Drag (single node)</b>: Move node and its ancestors
          </div>
        </div>
        <MiniMap nodeColor={minimapNodeColor} maskColor="var(--overlay-mask)" />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
