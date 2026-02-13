import ELK, {
  type ElkNode,
  type ElkExtendedEdge,
} from "elkjs/lib/elk.bundled.js";
import type { Node, Edge } from "@xyflow/react";
import type { GraphResponse } from "./types";

const elk = new ELK();

const NODE_WIDTH = 220;
const NODE_HEIGHT = 60;

export interface TxNodeData {
  txid: string;
  shortTxid: string;
  feeSats: number | null;
  feerateSatVb: number | null;
  rbfSignaling: boolean;
  isCoinbase: boolean;
  outputCount: number;
  label: string | null;
  [key: string]: unknown;
}

function shortTxid(txid: string): string {
  if (txid.length < 16) return txid;
  return txid.substring(0, 12) + "\u2026" + txid.substring(txid.length - 4);
}

export async function computeLayout(
  response: GraphResponse,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const nodeIds = new Set(Object.keys(response.nodes));

  const children: ElkNode[] = Object.keys(response.nodes)
    .sort()
    .map((txid) => ({
      id: txid,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));

  const elkEdges: ElkExtendedEdge[] = response.edges
    .filter((e) => nodeIds.has(e.funding_txid) && nodeIds.has(e.spending_txid))
    .map((e, i) => ({
      id: `e-${i}`,
      sources: [e.funding_txid],
      targets: [e.spending_txid],
    }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "30",
      "elk.spacing.edgeNode": "20",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children,
    edges: elkEdges,
  };

  const laid = await elk.layout(graph);

  const nodes: Node[] = (laid.children ?? []).map((n) => {
    const txid = n.id;
    const nodeData = response.nodes[txid]!;
    const enrichment = response.enrichments[txid];
    const labels = response.labels[txid];
    const isCoinbase =
      nodeData.inputs.length === 1 && nodeData.inputs[0]?.prevout === null;

    const data: TxNodeData = {
      txid,
      shortTxid: shortTxid(txid),
      feeSats: enrichment?.fee_sats ?? null,
      feerateSatVb: enrichment?.feerate_sat_vb ?? null,
      rbfSignaling: enrichment?.rbf_signaling ?? false,
      isCoinbase,
      outputCount: nodeData.outputs.length,
      label: labels?.[0]?.label ?? null,
    };

    return {
      id: txid,
      type: "tx",
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      data,
    };
  });

  const edges: Edge[] = response.edges
    .filter((e) => nodeIds.has(e.funding_txid) && nodeIds.has(e.spending_txid))
    .map((e, i) => ({
      id: `e-${i}`,
      source: e.funding_txid,
      target: e.spending_txid,
      type: "smoothstep",
    }));

  return { nodes, edges };
}
