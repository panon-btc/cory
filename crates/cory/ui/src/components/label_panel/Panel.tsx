import { type CSSProperties, useState } from "react";
import { useAppStore } from "../../store";
import SelectedTxEditor from "./SelectedTxEditor";
import { CrudManager } from "./CrudManager";

interface LabelPanelProps {
  width: number;
  onClose: () => void;
}

export default function LabelPanel({ width, onClose }: LabelPanelProps) {
  const labelFiles = useAppStore((s) => s.labelFiles);

  const [panelError, setPanelError] = useState<string | null>(null);

  const persistentRwFiles = labelFiles.filter((file) => file.kind === "persistent_rw");
  const persistentRoFiles = labelFiles.filter((file) => file.kind === "persistent_ro");
  const browserFiles = labelFiles.filter((file) => file.kind === "browser_rw");
  const sectionStyle: CSSProperties = {
    border: "1px solid var(--border)",
    borderRadius: 4,
    background: "var(--overlay-subtle)",
    padding: "6px 8px",
  };
  const summaryStyle: CSSProperties = {
    color: "var(--accent)",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 12,
  };
  const serverListStyle: CSSProperties = {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  const renderServerFileItem = (file: (typeof labelFiles)[number]) => (
    <li
      key={file.id}
      style={{
        fontSize: 12,
      }}
    >
      <div style={{ color: "var(--text)" }}>
        {file.name}{" "}
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>({file.record_count})</span>
      </div>
    </li>
  );

  return (
    <div
      style={{
        width,
        minWidth: 300,
        maxWidth: 900,
        flexShrink: 0,
        background: "var(--surface)",
        padding: 12,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onClose}
          title="Close label panel"
          aria-label="Close label panel"
          style={{
            width: 22,
            height: 22,
            padding: 0,
            lineHeight: 1,
            fontSize: 14,
            borderRadius: 3,
          }}
        >
          ×
        </button>
      </div>

      <details open style={sectionStyle}>
        <summary style={summaryStyle}>Server Labels</summary>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div style={{ color: "var(--accent)", fontSize: 11, marginBottom: 4 }}>
              Read Only Labels
            </div>
            {persistentRoFiles.length > 0 ? (
              <ul style={serverListStyle}>{persistentRoFiles.map(renderServerFileItem)}</ul>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                Load read only labels on CLI via --labels-ro
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div style={{ color: "var(--accent)", fontSize: 11, marginBottom: 4 }}>
              Read Write Labels
            </div>
            {persistentRwFiles.length > 0 ? (
              <ul style={serverListStyle}>{persistentRwFiles.map(renderServerFileItem)}</ul>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                Load read write labels on CLI via --labels-rw
              </div>
            )}
          </div>

          {persistentRoFiles.length === 0 && persistentRwFiles.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
              No server labels loaded. Start cory with <code>--labels-ro</code> and/or{" "}
              <code>--labels-rw</code>.
            </p>
          )}
        </div>
      </details>

      <CrudManager
        browserFiles={browserFiles}
        sectionStyle={sectionStyle}
        summaryStyle={summaryStyle}
        setPanelError={setPanelError}
      />

      <details open style={sectionStyle}>
        <summary style={summaryStyle}>Selected Transaction Editor</summary>
        <div style={{ marginTop: 8 }}>
          <SelectedTxEditor />
        </div>
      </details>

      {panelError && <p style={{ color: "var(--accent)", fontSize: 11 }}>{panelError}</p>}
    </div>
  );
}
