import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage, isAuthError } from "../../api";
import type { Bip329Type, LabelEntry, LabelFileSummary } from "../../types";
import { useAutosave, type SaveState } from "../../hooks/useAutosave";

// ==============================================================================
// Shared helpers
// ==============================================================================

function stateColor(state: SaveState): string {
  if (state === "saved") return "var(--ok)";
  if (state === "error") return "var(--accent)";
  return "var(--text-muted)";
}

// Suppress auth errors (the store's handleAuthError already surfaces them
// in the header) and surface everything else as a local error string.
function autosaveErrorHandler(err: unknown): string | null {
  return isAuthError(err) ? null : errorMessage(err, "request failed");
}

// ==============================================================================
// EditableLabelRow — one row per editable label, each with its own useAutosave
// ==============================================================================

interface EditableLabelRowProps {
  entry: LabelEntry;
  labelType: Bip329Type;
  refId: string;
  onSaveLabel: (
    fileId: string,
    labelType: Bip329Type,
    refId: string,
    label: string,
  ) => Promise<void>;
  onDeleteLabel: (fileId: string, labelType: Bip329Type, refId: string) => Promise<void>;
  onError: (error: string | null) => void;
}

function EditableLabelRow({
  entry,
  labelType,
  refId,
  onSaveLabel,
  onDeleteLabel,
  onError,
}: EditableLabelRowProps) {
  const [draft, setDraft] = useState(entry.label);

  // Reset draft when the upstream label changes (e.g. after save round-trips
  // through the store and graph refresh).
  useEffect(() => {
    setDraft(entry.label);
  }, [entry.label]);

  const handleSave = useCallback(
    async (value: string) => {
      await onSaveLabel(entry.file_id, labelType, refId, value);
    },
    [entry.file_id, labelType, refId, onSaveLabel],
  );

  const { state, error, setState } = useAutosave(draft, true, handleSave, autosaveErrorHandler);

  // Bubble save errors up to the parent for unified display.
  useEffect(() => {
    onError(error);
  }, [error, onError]);

  const handleDelete = useCallback(async () => {
    try {
      onError(null);
      await onDeleteLabel(entry.file_id, labelType, refId);
    } catch (err) {
      if (isAuthError(err)) return;
      onError(errorMessage(err, "request failed"));
    }
  }, [entry.file_id, labelType, refId, onDeleteLabel, onError]);

  return (
    <div style={{ display: "flex", gap: 4 }}>
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
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setState("dirty");
        }}
        autoComplete="off"
        spellCheck={false}
        style={{ flex: 1, fontSize: 10, padding: "2px 6px" }}
      />
      <span
        style={{
          fontSize: 12,
          color: stateColor(state),
          alignSelf: "center",
        }}
        title={state}
      >
        ✓
      </span>
      <button
        onClick={() => void handleDelete()}
        style={{ fontSize: 10, padding: "2px 6px" }}
        title="Delete label"
      >
        🗑
      </button>
    </div>
  );
}

// ==============================================================================
// TargetLabelEditor — main component
// ==============================================================================

interface TargetLabelEditorProps {
  title: ReactNode;
  subtitle?: ReactNode;
  labelType: Bip329Type;
  refId: string;
  labels: LabelEntry[];
  editableFiles: LabelFileSummary[];
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
  editableFiles,
  onSaveLabel,
  onDeleteLabel,
  disabled = false,
  disabledMessage,
  note,
}: TargetLabelEditorProps) {
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
    () => editableFiles.filter((file) => !editableFileIds.has(file.id)),
    [editableFiles, editableFileIds],
  );

  // Reset the "add new label" form when the target changes.
  useEffect(() => {
    setIsAdding(false);
    setNewLabel("");
    setEditorError(null);
  }, [refId, labelType]);

  useEffect(() => {
    const hasCurrentSelection = addableFiles.some((file) => file.id === newFileId);
    if (hasCurrentSelection) {
      return;
    }
    const firstLocalFile = addableFiles[0];
    setNewFileId(firstLocalFile?.id ?? "");
  }, [newFileId, addableFiles]);

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
  } = useAutosave(newLabel, isAdding && !!newFileId, newLabelSave, autosaveErrorHandler);

  // Surface errors from both save paths in a single place.
  const displayError = editorError ?? newLabelError;

  return (
    <div
      data-testid="target-label-editor"
      data-label-type={labelType}
      data-ref-id={refId}
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
            <EditableLabelRow
              key={entry.file_id}
              entry={entry}
              labelType={labelType}
              refId={refId}
              onSaveLabel={onSaveLabel}
              onDeleteLabel={onDeleteLabel}
              onError={setEditorError}
            />
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
            ) : editableFiles.length === 0 ? (
              <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                Create or import a label file first.
              </div>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                Labels already exist for all editable files.
              </div>
            )
          ) : addableFiles.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
              No additional editable files available.
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
                  <span style={{ color: "var(--text-muted)" }}>{entry.file_name}: </span>
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
