import type { LabelEntry } from "../../../Types";
import { readOnlyFileNameStyle, readOnlyListStyle, readOnlyRowStyle } from "./Index";

interface ReadOnlyLabelListProps {
  entries: LabelEntry[];
}

export function ReadOnlyLabelList({ entries }: ReadOnlyLabelListProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div style={readOnlyListStyle}>
      {entries.map((entry) => (
        <div key={`${entry.file_id}:${entry.label}`} style={readOnlyRowStyle}>
          <span style={readOnlyFileNameStyle}>{entry.file_name}:</span>
          <span style={{ color: "var(--text)" }}>{entry.label}</span>
        </div>
      ))}
    </div>
  );
}
