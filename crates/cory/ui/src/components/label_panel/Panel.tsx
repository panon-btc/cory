import { type CSSProperties, useState } from "react";
import { useAppStore } from "../../store";
import SelectedTxEditor from "./SelectedTxEditor";
import { CrudManager } from "./CrudManager";

interface LabelPanelProps {
  width: number;
}

export default function LabelPanel({ width }: LabelPanelProps) {
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
      {persistentRwFiles.length > 0 && (
        <details open style={sectionStyle}>
          <summary style={summaryStyle}>Persistent Labels</summary>
          <div style={{ marginTop: 8 }}>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {persistentRwFiles.map((file) => (
                <li
                  key={file.id}
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ color: "var(--text)" }}>{file.name}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                    {file.record_count} labels
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      <details open style={sectionStyle}>
        <summary style={summaryStyle}>Server Labels</summary>
        <div style={{ marginTop: 8 }}>
          {persistentRoFiles.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {persistentRoFiles.map((file) => (
                <li
                  key={file.id}
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ color: "var(--text)" }}>{file.name}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                    {file.record_count} labels
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>No label packs loaded.</p>
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
