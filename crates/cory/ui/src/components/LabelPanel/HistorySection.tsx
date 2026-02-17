// ==============================================================================
// History Section Component
// ==============================================================================
//
// Renders the list of recent searches from the application history.

import type { CSSProperties } from "react";
import { shortTxid } from "../../utils/Format";
import type { HistoryEntry } from "../../Types";

interface HistorySectionProps {
  historyEntries: HistoryEntry[];
  doSearch: (txid: string) => Promise<void>;
  sectionStyle: CSSProperties;
  summaryStyle: CSSProperties;
  listStyle: CSSProperties;
}

export function HistorySection({
  historyEntries,
  doSearch,
  sectionStyle,
  summaryStyle,
  listStyle,
}: HistorySectionProps) {
  return (
    <details open style={sectionStyle}>
      <summary style={summaryStyle}>History</summary>
      <div style={{ marginTop: 8 }}>
        {historyEntries.length > 0 ? (
          <ul style={listStyle}>
            {historyEntries.map((entry) => (
              <li key={entry.txid} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <button
                  className="row-action-button"
                  type="button"
                  onClick={() => void doSearch(entry.txid)}
                  title={`Search txid ${entry.txid}`}
                  style={{ padding: 0, fontSize: 12 }}
                >
                  {shortTxid(entry.txid)}
                </button>
                <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                  {entry.searched_at}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
            No searches yet since server start.
          </div>
        )}
      </div>
    </details>
  );
}
