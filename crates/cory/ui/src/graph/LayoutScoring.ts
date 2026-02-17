// ==============================================================================
// Layout Scoring Utilities
// ==============================================================================
//
// Shared logic for node reordering and cross-minimization within the graph
// layout engine. These functions help optimize the vertical order of nodes
// based on their connectivity.

import type { AncestryEdge } from "../Types";

export const NEIGHBOR_WEIGHT = 100;

/**
 * Calculates a vertical "gravity" score for a node based on the positions
 * of its parents and children. Lower scores mean the node should generally
 * be placed higher in the layout.
 */
export function calculateNodeGravityScore(
  txid: string,
  indexByTx: Map<string, number>,
  incoming: AncestryEdge[],
  outgoing: AncestryEdge[],
): number {
  let sum = 0;
  let count = 0;

  for (const edge of incoming) {
    const parentIndex = indexByTx.get(edge.funding_txid);
    if (parentIndex == null) continue;
    sum += parentIndex * NEIGHBOR_WEIGHT + edge.funding_vout;
    count += 1;
  }

  for (const edge of outgoing) {
    const childIndex = indexByTx.get(edge.spending_txid);
    if (childIndex == null) continue;
    sum += childIndex * NEIGHBOR_WEIGHT + edge.funding_vout;
    count += 1;
  }

  if (count > 0) return sum / count;
  return (indexByTx.get(txid) ?? 0) * NEIGHBOR_WEIGHT;
}

/**
 * Calculates the "inversion cost" (crossing count) for a specific order
 * of sibling nodes.
 */
export function calculateInversionCost(
  orderedIds: string[],
  incomingBySpending: Map<string, AncestryEdge[]>,
  outgoingByFunding: Map<string, AncestryEdge[]>,
  leftKey: (edge: AncestryEdge) => number,
  rightKey: (edge: AncestryEdge) => number,
): number {
  let cost = 0;
  for (let i = 0; i < orderedIds.length; i += 1) {
    for (let j = i + 1; j < orderedIds.length; j += 1) {
      const a = orderedIds[i]!;
      const b = orderedIds[j]!;

      const aIncoming = incomingBySpending.get(a) ?? [];
      const bIncoming = incomingBySpending.get(b) ?? [];
      for (const ea of aIncoming) {
        for (const eb of bIncoming) {
          if (leftKey(ea) > leftKey(eb)) cost += 1;
        }
      }

      const aOutgoing = outgoingByFunding.get(a) ?? [];
      const bOutgoing = outgoingByFunding.get(b) ?? [];
      for (const ea of aOutgoing) {
        for (const eb of bOutgoing) {
          if (rightKey(ea) > rightKey(eb)) cost += 1;
        }
      }
    }
  }
  return cost;
}
