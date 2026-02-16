import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, Trash2 } from "lucide-react";
import { errorMessage, isAuthError } from "../../../api";
import { useAutosave } from "../../../hooks/useAutosave";
import type { Bip329Type, LabelEntry } from "../../../types";
import {
  autosaveErrorHandler,
  compactInputStyle,
  compactRowStyle,
  deleteButtonStyle,
  editableFileTagStyle,
  stateColor,
  statusIconStyle,
  type DeleteLabelFn,
  type SaveLabelFn,
} from "./index";

interface EditableLabelRowProps {
  entry: LabelEntry;
  labelType: Bip329Type;
  refId: string;
  onSaveLabel: SaveLabelFn;
  onDeleteLabel: DeleteLabelFn;
  onError: (error: string | null) => void;
}

export function EditableLabelRow({
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

  const handleChangeDraft = useCallback(
    (value: string) => {
      setDraft(value);
      setState("dirty");
    },
    [setState],
  );

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
    <div style={compactRowStyle}>
      <span style={editableFileTagStyle} title={entry.file_id}>
        {entry.file_name}
      </span>
      <input
        type="text"
        value={draft}
        onChange={(e) => handleChangeDraft(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        style={compactInputStyle}
      />
      <span
        style={{
          ...statusIconStyle,
          color: stateColor(state),
        }}
        title={state}
      >
        {state === "saved" ? (
          <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Circle size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </span>
      <button onClick={() => void handleDelete()} style={deleteButtonStyle} title="Delete label">
        <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
