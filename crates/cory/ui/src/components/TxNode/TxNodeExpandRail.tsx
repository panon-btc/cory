// ==============================================================================
// TxNode Expand Rail Component
// ==============================================================================
//
// The interactive vertical bar on the left of a node that allows the user
// to expand or collapse parent transactions (inputs).

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { BaseRail, RAIL_ICON_SIZE, RAIL_ICON_STROKE } from "./BaseRail";

interface TxNodeExpandRailProps {
  txid: string;
  expandMode: "expand" | "collapse";
  toggleDisabled: boolean;
  toggleLoading: boolean;
  onToggleExpand: (txid: string) => void;
}

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
  // If disabled and in expand mode, render a simple placeholder.
  if (toggleDisabled && expandMode === "expand") {
    return <BaseRail side="left" gridColumn={IO_GRID_COL_EXPAND_BUTTON} disabled />;
  }

  return (
    <BaseRail
      side="left"
      gridColumn={IO_GRID_COL_EXPAND_BUTTON}
      onClick={() => onToggleExpand(txid)}
      disabled={toggleDisabled}
      loading={toggleLoading}
      title={expandButtonTitle(expandMode, toggleLoading, toggleDisabled)}
      ariaLabel={
        expandMode === "collapse" ? "Collapse input transactions" : "Expand input transactions"
      }
    >
      {expandMode === "collapse" ? (
        <>
          <ChevronsRight size={RAIL_ICON_SIZE} strokeWidth={RAIL_ICON_STROKE} aria-hidden="true" />
          <ChevronsRight size={RAIL_ICON_SIZE} strokeWidth={RAIL_ICON_STROKE} aria-hidden="true" />
        </>
      ) : (
        <>
          <ChevronsLeft size={RAIL_ICON_SIZE} strokeWidth={RAIL_ICON_STROKE} aria-hidden="true" />
          <ChevronsLeft size={RAIL_ICON_SIZE} strokeWidth={RAIL_ICON_STROKE} aria-hidden="true" />
        </>
      )}
    </BaseRail>
  );
}
