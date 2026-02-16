import { type CSSProperties } from "react";
import { errorMessage, isAuthError } from "../../../api";
import type { SaveState } from "../../../hooks/useAutosave";
import type { Bip329Type, LabelEntry } from "../../../types";

export type SaveLabelFn = (
  fileId: string,
  labelType: Bip329Type,
  refId: string,
  label: string,
) => Promise<void>;

export type DeleteLabelFn = (fileId: string, labelType: Bip329Type, refId: string) => Promise<void>;

// ==============================================================================
// Shared styles
// ==============================================================================

export const editorContainerStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

export const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
};

export const subtitleStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 10,
  overflowWrap: "anywhere",
};

export const mutedTextStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 10,
};

export const errorTextStyle: CSSProperties = {
  color: "var(--error)",
  fontSize: 10,
};

export const sectionDividerStyle: CSSProperties = {
  borderTop: "1px solid var(--border)",
  paddingTop: 6,
};

export const sectionSeparatorStyle: CSSProperties = {
  borderTop: "1px solid var(--border)",
};

export const compactRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
};

export const compactInputStyle: CSSProperties = {
  flex: 1,
  fontSize: 10,
  padding: "2px 6px",
};

export const compactSelectStyle: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10,
  background: "var(--surface-1)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-subtle)",
};

export const statusIconStyle: CSSProperties = {
  alignSelf: "center",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  lineHeight: 0,
};

export const iconActionButtonStyle: CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--border-subtle)",
  color: "var(--text-secondary)",
  lineHeight: 1,
  width: 22,
  height: 22,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
};

export const deleteButtonStyle: CSSProperties = {
  ...iconActionButtonStyle,
  fontSize: 16,
  width: 24,
  height: 24,
};

export const editableFileTagStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  alignSelf: "center",
  minWidth: 56,
};

export const readOnlyFileNameStyle: CSSProperties = {
  color: "var(--text-secondary)",
};

export const readOnlyListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

export const readOnlyRowStyle: CSSProperties = {
  fontSize: 10,
};

export function stateColor(state: SaveState): string {
  return state === "saved" ? "var(--ok)" : "var(--text-muted)";
}

export function partitionLabels(labels: LabelEntry[]): readonly [LabelEntry[], LabelEntry[]] {
  const editable: LabelEntry[] = [];
  const readonly: LabelEntry[] = [];

  for (const entry of labels) {
    if (entry.editable) editable.push(entry);
    else readonly.push(entry);
  }

  return [editable, readonly] as const;
}

export function idleAddMessage(addableFileCount: number, editableFileCount: number): string | null {
  if (addableFileCount > 0) {
    return null;
  }
  if (editableFileCount === 0) {
    return "Create or import a label file first.";
  }
  return "Labels already exist for all editable files.";
}

// Suppress auth errors (the store's handleAuthError already surfaces them
// in the header) and surface everything else as a local error string.
export function autosaveErrorHandler(err: unknown): string | null {
  return isAuthError(err) ? null : errorMessage(err, "request failed");
}
