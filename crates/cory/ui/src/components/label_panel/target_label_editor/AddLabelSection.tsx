import { CheckCircle2, Circle, Trash2 } from "lucide-react";
import type { SaveState } from "../../../hooks/useAutosave";
import type { LabelFileSummary } from "../../../types";
import {
  compactInputStyle,
  compactRowStyle,
  compactSelectStyle,
  deleteButtonStyle,
  mutedTextStyle,
  stateColor,
  sectionDividerStyle,
  statusIconStyle,
} from "./index";

interface AddLabelSectionProps {
  showDivider: boolean;
  isAdding: boolean;
  newFileId: string;
  newLabel: string;
  newLabelState: SaveState;
  addableFiles: LabelFileSummary[];
  idleMessage: string | null;
  onCancelAdding: () => void;
  onChangeFileId: (fileId: string) => void;
  onChangeLabelDraft: (label: string) => void;
}

export function AddLabelSection({
  showDivider,
  isAdding,
  newFileId,
  newLabel,
  newLabelState,
  addableFiles,
  idleMessage,
  onCancelAdding,
  onChangeFileId,
  onChangeLabelDraft,
}: AddLabelSectionProps) {
  const containerStyle = showDivider ? sectionDividerStyle : undefined;

  if (!isAdding) {
    return (
      <div style={containerStyle}>
        {idleMessage && <div style={mutedTextStyle}>{idleMessage}</div>}
      </div>
    );
  }

  if (addableFiles.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={mutedTextStyle}>No additional editable files available.</div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={compactRowStyle}>
        <select
          value={newFileId}
          onChange={(e) => onChangeFileId(e.target.value)}
          style={compactSelectStyle}
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
          onChange={(e) => onChangeLabelDraft(e.target.value)}
          placeholder="Label"
          autoComplete="off"
          spellCheck={false}
          style={compactInputStyle}
        />
        <span
          style={{
            ...statusIconStyle,
            color: stateColor(newLabelState),
          }}
          title={newLabelState}
        >
          {newLabelState === "saved" ? (
            <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Circle size={14} strokeWidth={2} aria-hidden="true" />
          )}
        </span>
        <button
          type="button"
          onClick={onCancelAdding}
          style={deleteButtonStyle}
          title="Cancel add label"
          aria-label="Cancel add label"
        >
          <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
