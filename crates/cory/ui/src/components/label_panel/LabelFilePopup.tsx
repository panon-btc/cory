import { type CSSProperties, useEffect } from "react";
import type { LabelFileSummary } from "../../types";
import type { ParsedLabelRow } from "./label_file_popup_parse";

interface LabelFilePopupProps {
  file: LabelFileSummary;
  loading: boolean;
  error: string | null;
  rows: ParsedLabelRow[];
  onClose: () => void;
  onRetry: () => void;
  onRowClick: (row: ParsedLabelRow) => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1200,
  background: "var(--overlay-mask)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const popupStyle: CSSProperties = {
  width: "min(760px, 100%)",
  maxHeight: "min(80vh, 900px)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 8,
  borderBottom: "1px solid var(--border)",
  padding: "10px 12px",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--text)",
  overflowWrap: "anywhere",
};

const subtitleStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 10,
  color: "var(--text-muted)",
};

const stateStyle: CSSProperties = {
  padding: "16px 12px",
  color: "var(--text-muted)",
  fontSize: 11,
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  overflow: "auto",
};

const rowStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
};

const rowButtonStyle: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: 0,
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  color: "var(--text)",
  padding: "8px 12px",
};

const disabledRowButtonStyle: CSSProperties = {
  ...rowButtonStyle,
  opacity: 0.65,
  cursor: "not-allowed",
};

const rowLabelStyle: CSSProperties = {
  fontSize: 12,
  overflowWrap: "anywhere",
};

const rowMetaStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 10,
  color: "var(--text-muted)",
  display: "flex",
  gap: 8,
  overflowWrap: "anywhere",
};

export function LabelFilePopup({
  file,
  loading,
  error,
  rows,
  onClose,
  onRetry,
  onRowClick,
}: LabelFilePopupProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div style={overlayStyle} onMouseDown={onClose}>
      <div
        style={popupStyle}
        role="dialog"
        aria-modal="true"
        aria-label={`Labels from ${file.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <h2 style={titleStyle}>{file.name}</h2>
            <div style={subtitleStyle}>
              {file.kind} • {file.record_count} record{file.record_count === 1 ? "" : "s"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close labels popup"
            aria-label="Close labels popup"
            style={{ width: 22, height: 22, padding: 0, lineHeight: 1, fontSize: 14, borderRadius: 3 }}
          >
            ×
          </button>
        </div>

        {loading ? (
          <div style={stateStyle}>Loading labels…</div>
        ) : error ? (
          <div style={{ ...stateStyle, color: "var(--accent)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div>{error}</div>
            <button type="button" onClick={onRetry} style={{ fontSize: 11, padding: "3px 8px" }}>
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div style={stateStyle}>No labels in this file.</div>
        ) : (
          <ul style={listStyle}>
            {rows.map((row) => {
              const clickable = row.txidTarget !== null;
              return (
                <li key={`${row.lineNumber}-${row.type}-${row.ref}`} style={rowStyle}>
                  <button
                    type="button"
                    style={clickable ? rowButtonStyle : disabledRowButtonStyle}
                    onClick={() => clickable && onRowClick(row)}
                    disabled={!clickable}
                    title={
                      clickable
                        ? `Search txid ${row.txidTarget}`
                        : "No txid target for this label type/ref"
                    }
                  >
                    <div style={rowLabelStyle}>{row.label || "(empty label)"}</div>
                    <div style={rowMetaStyle}>
                      <span>{row.type}</span>
                      <span>{row.ref}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
