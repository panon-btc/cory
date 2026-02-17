// ==============================================================================
// TxNode Collapse Rail Component
// ==============================================================================
//
// The interactive vertical bar on the right of a node that allows the user
// to collapse the connection from the node that expanded it.

import { ChevronsRight } from "lucide-react";
import { NODE_EXPAND_RAIL_WIDTH } from "../../Constants";

interface TxNodeCollapseRailProps {
  txid: string;
  disabled: boolean;
  onCollapseNode: (txid: string) => void;
}

const COLLAPSE_BUTTON_RIGHT_PULL = -8;
const COLLAPSE_BUTTON_WIDTH_EXTRA = 8;
const COLLAPSE_BUTTON_ICON_SIZE = 12;
const COLLAPSE_BUTTON_ICON_STROKE = 2;
const IO_GRID_COL_COLLAPSE_BUTTON = 7;

export function TxNodeCollapseRail({ txid, disabled, onCollapseNode }: TxNodeCollapseRailProps) {
  if (disabled) {
    return (
      <div
        style={{
          gridColumn: IO_GRID_COL_COLLAPSE_BUTTON,
          alignSelf: "stretch",
          marginRight: COLLAPSE_BUTTON_RIGHT_PULL,
          width: NODE_EXPAND_RAIL_WIDTH + COLLAPSE_BUTTON_WIDTH_EXTRA,
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="nodrag nopan"
      onClick={() => onCollapseNode(txid)}
      aria-label="Collapse transaction"
      title="Collapse this transaction back into its spender"
      style={{
        gridColumn: IO_GRID_COL_COLLAPSE_BUTTON,
        alignSelf: "stretch",
        marginRight: COLLAPSE_BUTTON_RIGHT_PULL,
        width: NODE_EXPAND_RAIL_WIDTH + COLLAPSE_BUTTON_WIDTH_EXTRA,
        border: "none",
        borderLeft: "1px solid var(--border-strong)",
        background: "var(--surface-1)",
        color: "var(--text-muted)",
        borderRadius: 0,
        fontSize: 10,
        lineHeight: 1,
        padding: "6px 2px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-around",
        alignItems: "center",
      }}
    >
      <ChevronsRight
        size={COLLAPSE_BUTTON_ICON_SIZE}
        strokeWidth={COLLAPSE_BUTTON_ICON_STROKE}
        aria-hidden="true"
      />
      <ChevronsRight
        size={COLLAPSE_BUTTON_ICON_SIZE}
        strokeWidth={COLLAPSE_BUTTON_ICON_STROKE}
        aria-hidden="true"
      />
    </button>
  );
}
