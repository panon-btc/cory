import { type CSSProperties, useState, useCallback, useRef } from "react";
import {
  ApiError,
  createLabelFile,
  deleteLabelFile,
  errorMessage,
  exportAllBrowserLabelsZip,
  exportLabelFile,
  importLabelFile,
} from "../../api";
import type { LabelFileSummary } from "../../types";
import { useAppStore } from "../../store";

interface CrudManagerProps {
  browserFiles: LabelFileSummary[];
  sectionStyle: CSSProperties;
  summaryStyle: CSSProperties;
  setPanelError: (error: string | null) => void;
  onOpenFile: (file: LabelFileSummary) => void;
}

function fileNameWithoutJsonl(fileName: string): string {
  return fileName.toLowerCase().endsWith(".jsonl") ? fileName.slice(0, -6) : fileName;
}

// Manages browser label file CRUD: create, import (from .jsonl), export
// (via File System Access API or fallback download), and remove.
export function CrudManager({
  browserFiles,
  sectionStyle,
  summaryStyle,
  setPanelError,
  onOpenFile,
}: CrudManagerProps) {
  const labelsChanged = useAppStore((s) => s.labelsChanged);
  const storeHandleAuthError = useAppStore((s) => s.handleAuthError);

  const [newFileName, setNewFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (!storeHandleAuthError(err)) return false;
      setPanelError(null);
      return true;
    },
    [storeHandleAuthError, setPanelError],
  );

  const handleCreateFile = useCallback(async () => {
    const trimmed = newFileName.trim();
    if (!trimmed) return;

    try {
      await createLabelFile(trimmed);
      setNewFileName("");
      setPanelError(null);
      await labelsChanged({ refreshGraph: false });
    } catch (err) {
      if (handleAuthError(err)) return;
      setPanelError("Create failed: " + errorMessage(err, "request failed"));
    }
  }, [newFileName, labelsChanged, handleAuthError, setPanelError]);

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
        if (handleAuthError(err)) return;
        if (err instanceof ApiError && err.status === 409) {
          const name = fileNameWithoutJsonl(file.name);
          const message = `Label file '${name}' already exists. Choose a different file name and import again.`;
          setPanelError(message);
        } else {
          setPanelError("Import failed: " + errorMessage(err, "request failed"));
        }
      }

      e.target.value = "";
    },
    [labelsChanged, handleAuthError, setPanelError],
  );

  const handleExport = useCallback(
    async (file: LabelFileSummary) => {
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
        if (handleAuthError(err)) return;
        setPanelError("Export failed: " + errorMessage(err, "request failed"));
      }
    },
    [handleAuthError, setPanelError],
  );

  const handleExportAllBrowserLabels = useCallback(async () => {
    try {
      const blob = await exportAllBrowserLabelsZip();
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = "labels.zip";
      anchor.click();
      // Delay revocation so the browser has time to start the download.
      // Revoking immediately can cause the download to fail in some browsers.
      setTimeout(() => URL.revokeObjectURL(anchor.href), 60_000);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        window.alert("No browser label files to export.");
        return;
      }
      if (handleAuthError(err)) return;
      setPanelError("Export failed: " + errorMessage(err, "request failed"));
    }
  }, [handleAuthError, setPanelError]);

  const handleDelete = useCallback(
    async (file: LabelFileSummary) => {
      const confirmed = window.confirm(`Remove label file '${file.name}' from server memory?`);
      if (!confirmed) return;

      try {
        await deleteLabelFile(file.id);
        setPanelError(null);
        await labelsChanged({ refreshGraph: true });
      } catch (err) {
        if (handleAuthError(err)) return;
        setPanelError("Delete failed: " + errorMessage(err, "request failed"));
      }
    },
    [labelsChanged, handleAuthError, setPanelError],
  );

  return (
    <details open style={sectionStyle}>
      <summary style={summaryStyle}>Browser Labels</summary>
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
          Browser label files are stored in memory, if you forget to export before closing the
          server, changes will be lost.
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
          <button
            onClick={() => void handleExportAllBrowserLabels()}
            style={{ fontSize: 11, padding: "4px 8px" }}
          >
            Export all browser labels
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".jsonl"
          style={{ display: "none" }}
          onChange={handleImportFile}
        />

        {browserFiles.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {browserFiles.map((file) => (
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
                  <div style={{ minWidth: 0 }}>
                    <button
                      type="button"
                      onClick={() => onOpenFile(file)}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        padding: 0,
                        fontSize: 12,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                      title={`Open labels from '${file.name}'`}
                    >
                      {file.name}{" "}
                      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                        ({file.record_count})
                      </span>
                    </button>
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
          <p style={{ color: "var(--text-muted)", fontSize: 11 }}>No browser label files loaded.</p>
        )}
      </div>
    </details>
  );
}
