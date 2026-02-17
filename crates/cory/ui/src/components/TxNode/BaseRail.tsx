// ==============================================================================
// Base Rail Component
// ==============================================================================
//
// Shared layout and styling for the vertical interaction bars (rails)
// on the left and right sides of a transaction node.

import { NODE_EXPAND_RAIL_WIDTH } from "../../Constants";

export const RAIL_ICON_SIZE = 12;
export const RAIL_ICON_STROKE = 2;
const RAIL_PULL = -8;
const RAIL_WIDTH_EXTRA = 8;

interface BaseRailProps {
  side: "left" | "right";
  gridColumn: number;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export function BaseRail({
  side,
  gridColumn,
  onClick,
  disabled,
  loading,
  title,
  ariaLabel,
  children,
}: BaseRailProps) {
  const commonStyle: React.CSSProperties = {
    gridColumn,
    alignSelf: "stretch",
    width: NODE_EXPAND_RAIL_WIDTH + RAIL_WIDTH_EXTRA,
    [side === "left" ? "marginLeft" : "marginRight"]: RAIL_PULL,
  };

  if (disabled && !children) {
    return <div style={commonStyle} />;
  }

  return (
    <button
      type="button"
      className="nodrag nopan"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled || loading}
      style={{
        ...commonStyle,
        border: "none",
        [side === "left" ? "borderRight" : "borderLeft"]: "1px solid var(--border-strong)",
        background: "var(--surface-1)",
        color: "var(--text-muted)",
        borderRadius: 0,
        fontSize: 10,
        lineHeight: 1,
        padding: "6px 2px",
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-around",
        alignItems: "center",
      }}
    >
      {children}
    </button>
  );
}
