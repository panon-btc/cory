// ==============================================================================
// TxNode Expand Rail Component
// ==============================================================================
//
// The interactive vertical bar on the left of a node that allows the user
// to expand or collapse parent transactions (inputs).

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { NODE_EXPAND_RAIL_WIDTH } from "../../Constants";

interface TxNodeExpandRailProps {
  txid: string;
  expandMode: "expand" | "collapse";
  toggleDisabled: boolean;
  toggleLoading: boolean;
  onToggleExpand: (txid: string) => void;
}

const EXPAND_BUTTON_LEFT_PULL = -8;
const EXPAND_BUTTON_WIDTH_EXTRA = 8;
const EXPAND_BUTTON_ICON_SIZE = 12;
const EXPAND_BUTTON_ICON_STROKE = 2;
const IO_GRID_COL_EXPAND_BUTTON = 1;

function expandButtonTitle(
  expandMode: "expand" | "collapse",
  toggleLoading: boolean,
  toggleDisabled: boolean,
): string {
  if (toggleLoading) return "Expanding...";
  if (toggleDisabled) return "No expandable inputs";
  return expandMode === "collapse" ? "Collapse input transactions" : "Expand input transactions";
}

export function TxNodeExpandRail({
  txid,
  expandMode,
  toggleDisabled,
  toggleLoading,
  onToggleExpand,
}: TxNodeExpandRailProps) {
  return (
    <button
      type="button"
      className="nodrag nopan"
      onClick={() => onToggleExpand(txid)}
      aria-label={
        expandMode === "collapse" ? "Collapse input transactions" : "Expand input transactions"
      }
      title={expandButtonTitle(expandMode, toggleLoading, toggleDisabled)}
      disabled={toggleDisabled || toggleLoading}
      style={{
        gridColumn: IO_GRID_COL_EXPAND_BUTTON,
        alignSelf: "stretch",
        marginLeft: EXPAND_BUTTON_LEFT_PULL,
        width: NODE_EXPAND_RAIL_WIDTH + EXPAND_BUTTON_WIDTH_EXTRA,
        border: "none",
        borderRight: "1px solid var(--border-strong)",
        background: "var(--surface-1)",
        color: "var(--text-muted)",
        borderRadius: 0,
        fontSize: 10,
        lineHeight: 1,
        padding: "6px 2px",
        cursor: toggleDisabled || toggleLoading ? "not-allowed" : "pointer",
        opacity: toggleDisabled ? 0.55 : 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-around",
        alignItems: "center",
      }}
    >
      {expandMode === "collapse" ? (
        <>
          <ChevronsRight
            size={EXPAND_BUTTON_ICON_SIZE}
            strokeWidth={EXPAND_BUTTON_ICON_STROKE}
            aria-hidden="true"
          />
          <ChevronsRight
            size={EXPAND_BUTTON_ICON_SIZE}
            strokeWidth={EXPAND_BUTTON_ICON_STROKE}
            aria-hidden="true"
          />
        </>
      ) : (
        <>
          <ChevronsLeft
            size={EXPAND_BUTTON_ICON_SIZE}
            strokeWidth={EXPAND_BUTTON_ICON_STROKE}
            aria-hidden="true"
          />
          <ChevronsLeft
            size={EXPAND_BUTTON_ICON_SIZE}
            strokeWidth={EXPAND_BUTTON_ICON_STROKE}
            aria-hidden="true"
          />
        </>
      )}
    </button>
  );
}
