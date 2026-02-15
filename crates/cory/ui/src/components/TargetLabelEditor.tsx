import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, isAuthError } from "../api";
import type { Bip329Type, LabelEntry, LabelFileSummary } from "../types";
import { AUTOSAVE_DEBOUNCE_MS } from "../constants";
import { useAutosave, type SaveState } from "../hooks/useAutosave";

interface TargetLabelEditorProps {
  title: ReactNode;
  subtitle?: ReactNode;
  labelType: Bip329Type;
  refId: string;
  labels: LabelEntry[];
  localFiles: LabelFileSummary[];
  onSaveLabel: (
    fileId: string,
    labelType: Bip329Type,
    refId: string,
    label: string,
  ) => Promise<void>;
  onDeleteLabel: (fileId: string, labelType: Bip329Type, refId: string) => Promise<void>;
  disabled?: boolean;
  disabledMessage?: string;
  note?: string;
}

export default function TargetLabelEditor({
  title,
  subtitle,
  labelType,
  refId,
  labels,
  localFiles,
  onSaveLabel,
  onDeleteLabel,
  disabled = false,
  disabledMessage,
  note,
}: TargetLabelEditorProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const [isAdding, setIsAdding] = useState(false);
  const [newFileId, setNewFileId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);

  const editableEntries = useMemo(() => labels.filter((entry) => entry.editable), [labels]);

  const readonlyEntries = useMemo(() => labels.filter((entry) => !entry.editable), [labels]);

  const editableFileIds = useMemo(
    () => new Set(editableEntries.map((entry) => entry.file_id)),
    [editableEntries],
  );

  const addableFiles = useMemo(
    () => localFiles.filter((file) => !editableFileIds.has(file.id)),
    [localFiles, editableFileIds],
  );

  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    const nextStates: Record<string, SaveState> = {};
    for (const entry of editableEntries) {
      nextDrafts[entry.file_id] = entry.label;
      nextStates[entry.file_id] = "saved";
    }
    setDrafts(nextDrafts);
    setStates(nextStates);
    setIsAdding(false);
    setNewLabel("");
    setEditorError(null);
  }, [editableEntries, refId, labelType]);

  useEffect(() => {
    const hasCurrentSelection = addableFiles.some((file) => file.id === newFileId);
    if (hasCurrentSelection) {
      return;
    }
    const firstLocalFile = addableFiles[0];
    setNewFileId(firstLocalFile?.id ?? "");
  }, [newFileId, addableFiles]);

  const handleDelete = useCallback(
    async (fileId: string) => {
      try {
        setEditorError(null);
        await onDeleteLabel(fileId, labelType, refId);
      } catch (err) {
        if (isAuthError(err)) return;
        setEditorError(errorMessage(err, "request failed"));
      }
    },
    [labelType, onDeleteLabel, refId],
  );

  // Debounce autosave for existing labels: reset a timeout each time
  // drafts or states change, so we only save after the user stops
  // typing for AUTOSAVE_DEBOUNCE_MS.
  const savingRef = useRef(false);
  useEffect(() => {
    const dirtyFileIds = Object.entries(states)
      .filter(([, state]) => state === "dirty")
      .map(([fileId]) => fileId);

    if (dirtyFileIds.length === 0 || savingRef.current) return;

    const timer = window.setTimeout(() => {
      savingRef.current = true;
      for (const fileId of dirtyFileIds) {
        const next = drafts[fileId]?.trim();
        if (!next) continue;

        setStates((prev) => ({ ...prev, [fileId]: "saving" }));
        void onSaveLabel(fileId, labelType, refId, next)
          .then(() => {
            setEditorError(null);
            setStates((prev) => ({ ...prev, [fileId]: "saved" }));
          })
          .catch((err) => {
            if (isAuthError(err)) {
              setStates((prev) => ({ ...prev, [fileId]: "saved" }));
              return;
            }
            setEditorError(errorMessage(err, "request failed"));
            setStates((prev) => ({ ...prev, [fileId]: "error" }));
          })
          .finally(() => {
            savingRef.current = false;
          });
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [states, drafts, labelType, onSaveLabel, refId]);

  // Autosave for the new-label form: save after typing stops, then
  // close the form on success.
  const newLabelSave = useCallback(
    async (value: string) => {
      await onSaveLabel(newFileId, labelType, refId, value);
      setNewLabel("");
      setIsAdding(false);
    },
    [newFileId, labelType, refId, onSaveLabel],
  );

  const {
    state: newLabelState,
    error: newLabelError,
    setState: setNewLabelState,
  } = useAutosave(newLabel, isAdding && !!newFileId, newLabelSave, (err) =>
    isAuthError(err) ? null : errorMessage(err, "request failed"),
  );

  // Surface errors from both save paths in a single place.
  const displayError = editorError ?? newLabelError;

  function stateColor(state: SaveState): string {
    if (state === "saved") return "var(--ok)";
    if (state === "error") return "var(--accent)";
    return "var(--text-muted)";
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ color: "var(--accent)", fontSize: 11 }}>{title}</div>
          {subtitle && (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 10,
                overflowWrap: "anywhere",
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      </div>

      {note && <div style={{ color: "var(--text-muted)", fontSize: 10 }}>{note}</div>}

      {disabled ? (
        <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
          {disabledMessage ?? "Editing unavailable for this target."}
        </div>
      ) : (
        <>
          {editableEntries.map((entry) => (
            <div key={entry.file_id} style={{ display: "flex", gap: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  color: "var(--accent)",
                  alignSelf: "center",
                  minWidth: 56,
                }}
                title={entry.file_id}
              >
                {entry.file_name}
              </span>
              <input
                type="text"
                value={drafts[entry.file_id] ?? ""}
                onChange={(e) => {
                  setDrafts((prev) => ({
                    ...prev,
                    [entry.file_id]: e.target.value,
                  }));
                  setStates((prev) => ({ ...prev, [entry.file_id]: "dirty" }));
                }}
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, fontSize: 10, padding: "2px 6px" }}
              />
              <span
                style={{
                  fontSize: 12,
                  color: stateColor(states[entry.file_id] ?? "saved"),
                  alignSelf: "center",
                }}
                title={states[entry.file_id] ?? "saved"}
              >
                ✓
              </span>
              <button
                onClick={() => void handleDelete(entry.file_id)}
                style={{ fontSize: 10, padding: "2px 6px" }}
                title="Delete label"
              >
                🗑
              </button>
            </div>
          ))}

          {!isAdding ? (
            addableFiles.length > 0 ? (
              <button
                onClick={() => {
                  setIsAdding(true);
                  setEditorError(null);
                  setNewLabelState("saved");
                }}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  width: "fit-content",
                }}
                title="Add label"
              >
                +
              </button>
            ) : localFiles.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                Create or import a label file first.
              </div>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                Local labels already exist for all files.
              </div>
            )
          ) : addableFiles.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
              No additional local files available.
            </div>
          ) : (
            <div style={{ display: "flex", gap: 4 }}>
              <select
                value={newFileId}
                onChange={(e) => setNewFileId(e.target.value)}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  background: "var(--bg)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                }}
              >
                {addableFiles.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => {
                  setNewLabel(e.target.value);
                  setNewLabelState("dirty");
                }}
                placeholder="Label"
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, fontSize: 10, padding: "2px 6px" }}
              />
              <span
                style={{
                  fontSize: 12,
                  color: stateColor(newLabelState),
                  alignSelf: "center",
                }}
                title={newLabelState}
              >
                ✓
              </span>
            </div>
          )}

          {readonlyEntries.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {readonlyEntries.map((entry) => (
                <div key={`${entry.file_id}:${entry.label}`} style={{ fontSize: 10 }}>
                  <span style={{ color: "var(--text-muted)" }}>[{entry.file_name}] </span>
                  <span style={{ color: "var(--text)" }}>{entry.label}</span>
                </div>
              ))}
            </div>
          )}

          {displayError && (
            <div style={{ color: "var(--accent)", fontSize: 10 }}>{displayError}</div>
          )}
        </>
      )}
    </div>
  );
}
