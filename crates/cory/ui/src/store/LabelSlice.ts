// ==============================================================================
// Label Store Slice
// ==============================================================================

import { type StateCreator } from "zustand";
import { type AppState } from "./AppStore";
import type { Bip329Type, HistoryEntry, LabelEntry, LabelFileSummary } from "../Types";
import { deleteLabelInFile, fetchHistory, fetchLabelFiles, setLabelInFile } from "../Api";
import { labelBucket } from "../graph/GraphUtils";
import { internalState } from "./InternalState";

export interface LabelSlice {
  labelFiles: LabelFileSummary[];
  historyEntries: HistoryEntry[];
  refreshLabelFiles: () => Promise<LabelFileSummary[]>;
  refreshHistory: () => Promise<HistoryEntry[]>;
  saveLabel: (fileId: string, labelType: Bip329Type, refId: string, label: string) => Promise<void>;
  deleteLabel: (fileId: string, labelType: Bip329Type, refId: string) => Promise<void>;
  labelsChanged: (opts?: { refreshGraph?: boolean }) => Promise<void>;
}

export const createLabelSlice: StateCreator<AppState, [], [], LabelSlice> = (set, get) => ({
  labelFiles: [],
  historyEntries: [],

  refreshLabelFiles: async () => {
    try {
      const files = await fetchLabelFiles();
      set({ labelFiles: files, authError: null });
      return files;
    } catch (e) {
      get().handleAuthError(e);
      return get().labelFiles;
    }
  },

  refreshHistory: async () => {
    try {
      const { entries } = await fetchHistory();
      set({ historyEntries: entries, authError: null });
      return entries;
    } catch (e) {
      get().handleAuthError(e);
      return get().historyEntries;
    }
  },

  saveLabel: async (fileId, labelType, refId, label) => {
    let summary;
    try {
      summary = await setLabelInFile(fileId, labelType, refId, label);
      set({ authError: null });
    } catch (e) {
      get().handleAuthError(e);
      throw e;
    }

    set((state) => {
      const { graph } = state;
      if (!graph) return state;

      const next = {
        ...graph,
        labels_by_type: {
          tx: { ...graph.labels_by_type.tx },
          input: { ...graph.labels_by_type.input },
          output: { ...graph.labels_by_type.output },
          addr: { ...graph.labels_by_type.addr },
        },
      };

      const bucket = labelBucket(next.labels_by_type, labelType);
      if (!bucket) return state;

      const existing = [...(bucket[refId] ?? [])];
      const idx = existing.findIndex((entry) => entry.file_id === fileId);
      const fileInfo = get().labelFiles.find((f) => f.id === fileId);
      const row: LabelEntry = {
        file_id: fileId,
        file_name: summary.name,
        file_kind: fileInfo?.kind ?? "browser_rw",
        editable: fileInfo?.editable ?? true,
        label,
      };
      if (idx >= 0) {
        existing[idx] = row;
      } else {
        existing.push(row);
      }
      bucket[refId] = existing;

      return { graph: next };
    });

    await get().refreshLabelFiles();
  },

  deleteLabel: async (fileId, labelType, refId) => {
    try {
      await deleteLabelInFile(fileId, labelType, refId);
      set({ authError: null });
    } catch (e) {
      get().handleAuthError(e);
      throw e;
    }

    set((state) => {
      const { graph } = state;
      if (!graph) return state;

      const next = {
        ...graph,
        labels_by_type: {
          tx: { ...graph.labels_by_type.tx },
          input: { ...graph.labels_by_type.input },
          output: { ...graph.labels_by_type.output },
          addr: { ...graph.labels_by_type.addr },
        },
      };

      const bucket = labelBucket(next.labels_by_type, labelType);
      if (!bucket) return state;

      const existing = bucket[refId] ?? [];
      bucket[refId] = existing.filter((entry) => entry.file_id !== fileId);

      return { graph: next };
    });

    await get().refreshLabelFiles();
  },

  labelsChanged: async (opts) => {
    await get().refreshLabelFiles();
    if (opts?.refreshGraph === false) return;

    if (internalState.lastSearchTxid) {
      await get().doSearch(internalState.lastSearchTxid, {
        preserveSelectedTxid: get().selectedTxid,
        quietErrors: true,
      });
    }
  },
});
