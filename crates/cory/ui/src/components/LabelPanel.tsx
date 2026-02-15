import { type CSSProperties, useState, useCallback, useRef } from "react";
import {
  ApiError,
  createLabelFile,
  deleteLabelFile,
  exportLabelFile,
  importLabelFile,
} from "../api";
import type { LabelFileSummary } from "../types";
import { useAppStore } from "../store";
import SelectedTxEditor from "./SelectedTxEditor";

interface LabelPanelProps {
  width: number;
}

function fileNameWithoutJsonl(fileName: string): string {
  return fileName.toLowerCase().endsWith(".jsonl") ? fileName.slice(0, -6) : fileName;
}

export default function LabelPanel({ width }: LabelPanelProps) {
  const labelFiles = useAppStore((s) => s.labelFiles);
  const labelsChanged = useAppStore((s) => s.labelsChanged);

  const [newFileName, setNewFileName] = useState("");
  const [panelError, setPanelError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const localFiles = labelFiles.filter((file) => file.kind === "local");
  const packFiles = labelFiles.filter((file) => file.kind === "pack");
  const sectionStyle: CSSProperties = {
    border: "1px solid var(--border)",
    borderRadius: 4,
    background: "rgba(0, 0, 0, 0.12)",
    padding: "6px 8px",
  };
  const summaryStyle: CSSProperties = {
    color: "var(--accent)",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 12,
  };
  const handleCreateFile = useCallback(async () => {
    const trimmed = newFileName.trim();
    if (!trimmed) return;

    try {
      await createLabelFile(trimmed);
      setNewFileName("");
      setPanelError(null);
      await labelsChanged({ refreshGraph: false });
    } catch (err) {
      setPanelError("Create failed: " + (err as Error).message);
    }
  }, [newFileName, labelsChanged]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const content = await file.text();
        const name = fileNameWithoutJsonl(file.name);
        await importLabelFile(name, content);
        setPanelError(null);
        await labelsChanged({ refreshGraph: true });
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.status === 409) {
          const name = fileNameWithoutJsonl(file.name);
          const message = `Label file '${name}' already exists. Choose a different file name and import again.`;
          setPanelError(message);
          window.alert(message);
        } else {
          setPanelError("Import failed: " + (err as Error).message);
        }
      }

      e.target.value = "";
    },
    [labelsChanged],
  );

  const handleExport = useCallback(async (file: LabelFileSummary) => {
    try {
      const text = await exportLabelFile(file.id);
      const finalName = `${file.name}.jsonl`;

      type SavePickerWindow = Window & {
        showSaveFilePicker?: (opts: {
          suggestedName?: string;
          excludeAcceptAllOption?: boolean;
          types?: Array<{
            description: string;
            accept: Record<string, string[]>;
          }>;
        }) => Promise<{
          createWritable: () => Promise<{
            write: (data: Blob | string) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      };

      const picker = (window as SavePickerWindow).showSaveFilePicker;
      if (picker) {
        const handle = await picker({
          suggestedName: finalName,
          excludeAcceptAllOption: false,
          types: [
            {
              description: "JSON Lines",
              accept: {
                "application/json": [".jsonl"],
                "text/plain": [".jsonl"],
              },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return;
      }

      const blob = new Blob([text], { type: "text/plain" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = finalName;
      anchor.click();
      // Delay revocation so the browser has time to start the download.
      // Revoking immediately can cause the download to fail in some browsers.
      setTimeout(() => URL.revokeObjectURL(anchor.href), 60_000);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      setPanelError("Export failed: " + (err as Error).message);
    }
  }, []);

  const handleDelete = useCallback(
    async (file: LabelFileSummary) => {
      const confirmed = window.confirm(`Remove label file '${file.name}' from server memory?`);
      if (!confirmed) return;

      try {
        await deleteLabelFile(file.id);
        setPanelError(null);
        await labelsChanged({ refreshGraph: true });
      } catch (err) {
        setPanelError("Delete failed: " + (err as Error).message);
      }
    },
    [labelsChanged],
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
      <details open style={sectionStyle}>
        <summary style={summaryStyle}>Pack Labels</summary>
        <div style={{ marginTop: 8 }}>
          {packFiles.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {packFiles.map((file) => (
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
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>No pack label files loaded.</p>
          )}
        </div>
      </details>

      <details open style={sectionStyle}>
        <summary style={summaryStyle}>Label Files</summary>
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: 8,
              color: "var(--warning)",
              fontSize: 10,
              fontStyle: "italic",
              fontWeight: 700,
            }}
          >
            All label files are stored in memory, if you forget to export before closing the server,
            changes will be lost.
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleCreateFile();
                }
              }}
              placeholder="New file name"
              autoComplete="off"
              spellCheck={false}
              style={{ flex: 1 }}
            />
            <button onClick={() => void handleCreateFile()}>Create</button>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={handleImportClick} style={{ fontSize: 11, padding: "4px 8px" }}>
              Import JSONL
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".jsonl"
            style={{ display: "none" }}
            onChange={handleImportFile}
          />

          {localFiles.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {localFiles.map((file) => (
                <li
                  key={file.id}
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ color: "var(--text)" }}>{file.name}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                        {file.record_count} labels
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        onClick={() => void handleExport(file)}
                        style={{ fontSize: 10, padding: "2px 6px" }}
                      >
                        Export
                      </button>
                      <button
                        onClick={() => void handleDelete(file)}
                        style={{ fontSize: 10, padding: "2px 6px" }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>No local label files loaded.</p>
          )}
        </div>
      </details>

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
