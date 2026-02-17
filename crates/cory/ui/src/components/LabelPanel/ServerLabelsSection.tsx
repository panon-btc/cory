// ==============================================================================
// Server Labels Section Component
// ==============================================================================
//
// Renders the list of persistent (disk-backed) label files, both read-only
// and read-write.

import type { CSSProperties } from "react";
import type { LabelFileSummary } from "../../Types";

interface ServerLabelsSectionProps {
  persistentRoFiles: LabelFileSummary[];
  persistentRwFiles: LabelFileSummary[];
  onOpenFile: (file: LabelFileSummary) => void;
  sectionStyle: CSSProperties;
  summaryStyle: CSSProperties;
  listStyle: CSSProperties;
}

export function ServerLabelsSection({
  persistentRoFiles,
  persistentRwFiles,
  onOpenFile,
  sectionStyle,
  summaryStyle,
  listStyle,
}: ServerLabelsSectionProps) {
  const renderItem = (file: LabelFileSummary) => (
    <li key={file.id} style={{ fontSize: 12 }}>
      <button
        className="row-action-button"
        type="button"
        onClick={() => onOpenFile(file)}
        style={{ padding: 0, fontSize: 12 }}
        title={`Open labels from '${file.name}'`}
      >
        {file.name}{" "}
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>({file.record_count})</span>
      </button>
    </li>
  );

  return (
    <details open style={sectionStyle}>
      <summary style={summaryStyle}>Server Labels</summary>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        <div>
          <div style={{ color: "var(--accent)", fontSize: 11, marginBottom: 4 }}>
            Read Only Labels
          </div>
          {persistentRoFiles.length > 0 ? (
            <ul style={listStyle}>{persistentRoFiles.map(renderItem)}</ul>
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
            <ul style={listStyle}>{persistentRwFiles.map(renderItem)}</ul>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Load read write labels on CLI via --labels-rw
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
