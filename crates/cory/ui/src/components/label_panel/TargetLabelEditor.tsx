import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useAutosave } from "../../hooks/useAutosave";
import type { Bip329Type, LabelEntry, LabelFileSummary } from "../../types";
import { AddLabelSection } from "./target_label_editor/AddLabelSection";
import { EditableLabelRow } from "./target_label_editor/EditableLabelRow";
import { ReadOnlyLabelList } from "./target_label_editor/ReadOnlyLabelList";
import {
  autosaveErrorHandler,
  editorContainerStyle,
  errorTextStyle,
  headerStyle,
  mutedTextStyle,
  partitionLabels,
  sectionSeparatorStyle,
  subtitleStyle,
  type DeleteLabelFn,
  type SaveLabelFn,
} from "./target_label_editor";

interface TargetLabelEditorProps {
  title: ReactNode;
  subtitle?: ReactNode;
  labelType: Bip329Type;
  refId: string;
  labels: LabelEntry[];
  editableFiles: LabelFileSummary[];
  onSaveLabel: SaveLabelFn;
  onDeleteLabel: DeleteLabelFn;
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

  // Keep the render path flat by partitioning once in display order.
  const [editableEntries, readonlyEntries] = useMemo(() => partitionLabels(labels), [labels]);
  const persistentEditableEntries = useMemo(
    () => editableEntries.filter((entry) => entry.file_kind === "persistent_rw"),
    [editableEntries],
  );
  const browserEditableEntries = useMemo(
    () => editableEntries.filter((entry) => entry.file_kind === "browser_rw"),
    [editableEntries],
  );

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
    setNewFileId(addableFiles[0]?.id ?? "");
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
  const hasReadonlyEntries = readonlyEntries.length > 0;
  const hasPersistentEditableEntries = persistentEditableEntries.length > 0;
  const hasBrowserEditableEntries = browserEditableEntries.length > 0;
  const hasLabelSection =
    hasReadonlyEntries || hasPersistentEditableEntries || hasBrowserEditableEntries;

  const handleStartAdding = useCallback(() => {
    setIsAdding(true);
    setEditorError(null);
    setNewLabelState("saved");
  }, [setNewLabelState]);

  const handleLabelDraftChange = useCallback(
    (value: string) => {
      setNewLabel(value);
      setNewLabelState("dirty");
    },
    [setNewLabelState],
  );

  return (
    <div
      data-testid="target-label-editor"
      data-label-type={labelType}
      data-ref-id={refId}
      style={editorContainerStyle}
    >
      <div style={headerStyle}>
        <div>
          <div style={{ color: "var(--accent)", fontSize: 11 }}>{title}</div>
          {subtitle && <div style={subtitleStyle}>{subtitle}</div>}
        </div>
      </div>

      {note && <div style={mutedTextStyle}>{note}</div>}

      {disabled ? (
        <div style={mutedTextStyle}>
          {disabledMessage ?? "Editing unavailable for this target."}
        </div>
      ) : (
        <>
          {hasReadonlyEntries && <div style={sectionSeparatorStyle} />}

          {hasReadonlyEntries && <ReadOnlyLabelList entries={readonlyEntries} />}

          {hasReadonlyEntries && hasPersistentEditableEntries && (
            <div style={sectionSeparatorStyle} />
          )}

          {persistentEditableEntries.map((entry) => (
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

          {(hasReadonlyEntries || hasPersistentEditableEntries) && hasBrowserEditableEntries && (
            <div style={sectionSeparatorStyle} />
          )}

          {browserEditableEntries.map((entry) => (
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

          <AddLabelSection
            showDivider={hasLabelSection}
            isAdding={isAdding}
            newFileId={newFileId}
            newLabel={newLabel}
            newLabelState={newLabelState}
            addableFiles={addableFiles}
            editableFileCount={editableFiles.length}
            onStartAdding={handleStartAdding}
            onChangeFileId={setNewFileId}
            onChangeLabelDraft={handleLabelDraftChange}
          />

          {displayError && <div style={errorTextStyle}>{displayError}</div>}
        </>
      )}
    </div>
  );
}
