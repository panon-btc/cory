export interface GraphResponse {
  nodes: Record<string, TxNode>;
  edges: AncestryEdge[];
  root_txid: string;
  truncated: boolean;
  stats: { node_count: number; edge_count: number; max_depth_reached: number };
  enrichments: Record<string, TxEnrichment>;
  labels: Record<string, LabelEntry[]>;
}

export interface TxNode {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  vsize: number;
  weight: number;
  block_hash: string | null;
  block_height: number | null;
  block_time: number | null;
  inputs: TxInput[];
  outputs: TxOutput[];
}

export interface TxInput {
  prevout: string | null;
  sequence: number;
  value: number | null;
  script_type: string | null;
}

export interface TxOutput {
  value: number;
  script_pub_key: string;
  script_type: string;
}

export interface AncestryEdge {
  spending_txid: string;
  input_index: number;
  funding_txid: string;
  funding_vout: number;
}

export interface TxEnrichment {
  fee_sats: number | null;
  feerate_sat_vb: number | null;
  rbf_signaling: boolean;
  locktime: { raw: number; kind: string; active: boolean };
}

export interface LabelEntry {
  file_id: string;
  file_name: string;
  file_kind: "local" | "pack";
  editable: boolean;
  label: string;
}

export interface LabelFileSummary {
  id: string;
  name: string;
  kind: "local" | "pack";
  editable: boolean;
  record_count: number;
}
