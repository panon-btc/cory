// ==============================================================================
// TxNode Collapse Rail Component
// ==============================================================================
//
// The interactive vertical bar on the right of a node that allows the user
// to collapse the connection from the node that expanded it.

import { ChevronsRight } from "lucide-react";
import { BaseRail, RAIL_ICON_SIZE, RAIL_ICON_STROKE } from "./BaseRail";

interface TxNodeCollapseRailProps {
  txid: string;
  disabled: boolean;
  onCollapseNode: (txid: string) => void;
}

const IO_GRID_COL_COLLAPSE_BUTTON = 7;

export function TxNodeCollapseRail({ txid, disabled, onCollapseNode }: TxNodeCollapseRailProps) {
  return (
    <BaseRail
      side="right"
      gridColumn={IO_GRID_COL_COLLAPSE_BUTTON}
      onClick={() => onCollapseNode(txid)}
      disabled={disabled}
      title="Collapse this transaction back into its spender"
      ariaLabel="Collapse transaction"
    >
      <ChevronsRight size={RAIL_ICON_SIZE} strokeWidth={RAIL_ICON_STROKE} aria-hidden="true" />
      <ChevronsRight size={RAIL_ICON_SIZE} strokeWidth={RAIL_ICON_STROKE} aria-hidden="true" />
    </BaseRail>
  );
}
