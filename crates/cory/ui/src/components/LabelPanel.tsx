import { useState, useCallback, useRef } from "react";
import {
  ApiError,
  createLabelFile,
  deleteLabelFile,
  exportLabelFile,
  importLabelFile,
  replaceLabelFile,
} from "../api";
import type { LabelFileSummary } from "../types";

interface LabelPanelProps {
  labelFiles: LabelFileSummary[];
  onLabelsChanged: (opts?: { refreshGraph?: boolean }) => void | Promise<void>;
}

function normalizeLabelFileId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((segment) => segment.length > 0)
    .join("-");
}

function fileNameWithoutJsonl(fileName: string): string {
  return fileName.toLowerCase().endsWith(".jsonl")
    ? fileName.slice(0, -6)
    : fileName;
}

export default function LabelPanel({
  labelFiles,
  onLabelsChanged,
}: LabelPanelProps) {
  const [newFileName, setNewFileName] = useState("");
  const [panelError, setPanelError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCreateFile = useCallback(async () => {
    const trimmed = newFileName.trim();
    if (!trimmed) return;

    try {
      await createLabelFile(trimmed);
      setNewFileName("");
      setPanelError(null);
      onLabelsChanged({ refreshGraph: false });
    } catch (err) {
      setPanelError("Create failed: " + (err as Error).message);
    }
  }, [newFileName, onLabelsChanged]);

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
        onLabelsChanged({ refreshGraph: true });
      } catch (err) {
        const apiErr = err as ApiError;
        const fileId = normalizeLabelFileId(fileNameWithoutJsonl(file.name));
        if (apiErr.status === 409) {
          const confirmed = window.confirm(
            `Label file '${fileNameWithoutJsonl(file.name)}' already exists. Replace its content?`,
          );
          if (confirmed) {
            try {
              const content = await file.text();
              await replaceLabelFile(fileId, content);
              setPanelError(null);
              onLabelsChanged({ refreshGraph: true });
            } catch (replaceErr) {
              setPanelError("Replace failed: " + (replaceErr as Error).message);
            }
          }
        } else {
          setPanelError("Import failed: " + (err as Error).message);
        }
      }

      e.target.value = "";
    },
    [onLabelsChanged],
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
      URL.revokeObjectURL(anchor.href);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      setPanelError("Export failed: " + (err as Error).message);
    }
  }, []);

  const handleDelete = useCallback(
    async (file: LabelFileSummary) => {
      const confirmed = window.confirm(
        `Remove label file '${file.name}' from server memory?`,
      );
      if (!confirmed) return;

      try {
        await deleteLabelFile(file.id);
        setPanelError(null);
        onLabelsChanged({ refreshGraph: true });
      } catch (err) {
        setPanelError("Delete failed: " + (err as Error).message);
      }
    },
    [onLabelsChanged],
  );

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
        Label Files
      </h3>

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
        <button
          onClick={handleImportClick}
          style={{ fontSize: 11, padding: "4px 8px" }}
        >
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

      {panelError && (
        <p style={{ color: "var(--accent)", fontSize: 11 }}>{panelError}</p>
      )}

      {labelFiles.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {labelFiles.map((file) => (
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
        <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
          No local label files loaded.
        </p>
      )}
    </div>
  );
}
