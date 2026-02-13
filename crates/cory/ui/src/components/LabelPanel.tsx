import { useState, useCallback, useRef } from "react";
import type { GraphResponse } from "../types";
import { setLabel, importLabels, exportLabels } from "../api";

interface LabelPanelProps {
  graph: GraphResponse | null;
  selectedTxid: string | null;
  apiToken: string;
  onRefresh: () => void;
}

export default function LabelPanel({
  graph,
  selectedTxid,
  apiToken,
  onRefresh,
}: LabelPanelProps) {
  const [labelText, setLabelText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const labels = selectedTxid ? (graph?.labels[selectedTxid] ?? []) : [];

  const handleSave = useCallback(async () => {
    if (!selectedTxid || !labelText.trim()) return;
    if (!apiToken) {
      alert("Please enter an API token first.");
      return;
    }
    try {
      await setLabel(apiToken, selectedTxid, labelText.trim());
      setLabelText("");
      onRefresh();
    } catch (e) {
      alert("Error saving label: " + (e as Error).message);
    }
  }, [selectedTxid, labelText, apiToken, onRefresh]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSave();
    },
    [handleSave],
  );

  const handleImport = useCallback(async () => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!apiToken) {
        alert("Please enter an API token first.");
        return;
      }
      try {
        const text = await file.text();
        await importLabels(apiToken, text);
        alert("Labels imported successfully.");
        onRefresh();
      } catch (err) {
        alert("Import failed: " + (err as Error).message);
      }
      e.target.value = "";
    },
    [apiToken, onRefresh],
  );

  const handleExport = useCallback(async () => {
    try {
      const text = await exportLabels();
      const blob = new Blob([text], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "labels.jsonl";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert("Export failed: " + (e as Error).message);
    }
  }, []);

  return (
    <div
      style={{
        width: 340,
        minWidth: 260,
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
        padding: 12,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h3 style={{ fontSize: 13, color: "var(--accent)", margin: 0 }}>
        Labels
      </h3>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          onClick={handleImport}
          style={{ fontSize: 11, padding: "4px 8px" }}
        >
          Import JSONL
        </button>
        <button
          onClick={handleExport}
          style={{ fontSize: 11, padding: "4px 8px" }}
        >
          Export JSONL
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".jsonl"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      {selectedTxid ? (
        <div>
          <p
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              wordBreak: "break-all",
              marginBottom: 8,
            }}
          >
            {selectedTxid}
          </p>

          {labels.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {labels.map((l, i) => (
                <li
                  key={i}
                  style={{
                    padding: "4px 0",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                >
                  {l.label}{" "}
                  <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                    {l.namespace}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
              No labels.
            </p>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input
              type="text"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add or edit label..."
              style={{ flex: 1 }}
            />
            <button onClick={handleSave}>Save</button>
          </div>
        </div>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
          Click a transaction in the graph to view and edit its labels.
        </p>
      )}
    </div>
  );
}
