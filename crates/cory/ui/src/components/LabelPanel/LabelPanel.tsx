// ==============================================================================
// Label & Sidebar Panel Component
// ==============================================================================
//
// Root component for the right sidebar. Houses search history, label file
// management, and the transaction label editor. Handles modal/popup logic
// for inspecting large label files.

import { type CSSProperties, useCallback, useRef, useState } from "react";
import { useAppStore } from "../../store/AppStore";
import { errorMessage, exportLabelFile } from "../../Api";
import type { LabelFileSummary } from "../../Types";
import type { ThemeMode } from "../../hooks/UseThemeMode";
import { Moon, Sun, X } from "lucide-react";

import SelectedTxEditor from "./SelectedTxEditor";
import { CrudManager } from "./CrudManager";
import { LabelFilePopup } from "./LabelFilePopup";
import { HistorySection } from "./HistorySection";
import { ServerLabelsSection } from "./ServerLabelsSection";
import { parseLabelFileJsonl, type ParsedLabelRow } from "../../utils/LabelFileParser";

interface LabelPanelProps {
  width: number;
  onClose: () => void;
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
}

export default function LabelPanel({
  width,
  onClose,
  themeMode,
  onToggleThemeMode,
}: LabelPanelProps) {
  const labelFiles = useAppStore((s) => s.labelFiles);
  const historyEntries = useAppStore((s) => s.historyEntries);
  const doSearch = useAppStore((s) => s.doSearch);
  const storeHandleAuthError = useAppStore((s) => s.handleAuthError);

  const [panelError, setPanelError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<LabelFileSummary | null>(null);
  const [popupLoading, setPopupLoading] = useState(false);
  const [popupError, setPopupError] = useState<string | null>(null);
  const [popupRows, setPopupRows] = useState<ParsedLabelRow[]>([]);
  const popupLoadIdRef = useRef(0);

  const persistentRwFiles = labelFiles.filter((file) => file.kind === "persistent_rw");
  const persistentRoFiles = labelFiles.filter((file) => file.kind === "persistent_ro");
  const browserFiles = labelFiles.filter((file) => file.kind === "browser_rw");

  const sectionStyle: CSSProperties = {
    border: "1px solid var(--border-subtle)",
    borderRadius: 4,
    background: "var(--surface-2)",
    padding: "6px 8px",
  };
  const summaryStyle: CSSProperties = {
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 12,
  };
  const listStyle: CSSProperties = {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  const loadFileRows = useCallback(
    async (file: LabelFileSummary) => {
      const loadId = popupLoadIdRef.current + 1;
      popupLoadIdRef.current = loadId;

      setPopupLoading(true);
      setPopupError(null);
      setPopupRows([]);
      try {
        const content = await exportLabelFile(file.id);
        if (popupLoadIdRef.current !== loadId) return;
        setPopupRows(parseLabelFileJsonl(content));
      } catch (err) {
        if (popupLoadIdRef.current !== loadId) return;
        if (storeHandleAuthError(err)) {
          setPanelError(null);
          return;
        }
        setPopupError("Failed to load labels: " + errorMessage(err, "request failed"));
      } finally {
        if (popupLoadIdRef.current !== loadId) return;
        setPopupLoading(false);
      }
    },
    [storeHandleAuthError],
  );

  const openFilePopup = useCallback(
    (file: LabelFileSummary) => {
      setActiveFile(file);
      void loadFileRows(file);
    },
    [loadFileRows],
  );

  const closeFilePopup = useCallback(() => {
    popupLoadIdRef.current += 1;
    setActiveFile(null);
    setPopupLoading(false);
    setPopupError(null);
    setPopupRows([]);
  }, []);

  const retryLoadFileRows = useCallback(() => {
    if (!activeFile) return;
    void loadFileRows(activeFile);
  }, [activeFile, loadFileRows]);

  const handlePopupRowClick = useCallback(
    (row: ParsedLabelRow) => {
      if (!row.txidTarget) return;
      void doSearch(row.txidTarget);
      closeFilePopup();
    },
    [closeFilePopup, doSearch],
  );

  return (
    <div
      style={{
        width,
        minWidth: 300,
        maxWidth: 900,
        flexShrink: 0,
        background: "var(--surface-1)",
        borderLeft: "1px solid var(--border-subtle)",
        padding: 12,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Panel Toolbar */}
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}
      >
        <button
          className="icon-btn"
          type="button"
          onClick={onToggleThemeMode}
          title={themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label={themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          style={{ borderRadius: 999, width: 28 }}
        >
          {themeMode === "dark" ? (
            <Sun size={14} strokeWidth={2} />
          ) : (
            <Moon size={14} strokeWidth={2} />
          )}
        </button>
        <button
          className="icon-btn"
          type="button"
          onClick={onClose}
          title="Close label panel"
          aria-label="Close label panel"
          style={{ borderRadius: 3 }}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <HistorySection
        historyEntries={historyEntries}
        doSearch={doSearch}
        sectionStyle={sectionStyle}
        summaryStyle={summaryStyle}
        listStyle={listStyle}
      />

      <ServerLabelsSection
        persistentRoFiles={persistentRoFiles}
        persistentRwFiles={persistentRwFiles}
        onOpenFile={openFilePopup}
        sectionStyle={sectionStyle}
        summaryStyle={summaryStyle}
        listStyle={listStyle}
      />

      <CrudManager
        browserFiles={browserFiles}
        sectionStyle={sectionStyle}
        summaryStyle={summaryStyle}
        setPanelError={setPanelError}
        onOpenFile={openFilePopup}
      />

      <details open style={sectionStyle}>
        <summary style={summaryStyle}>Selected Transaction Editor</summary>
        <div style={{ marginTop: 8 }}>
          <SelectedTxEditor />
        </div>
      </details>

      {panelError && (
        <p className="text-error" style={{ fontSize: 11 }}>
          {panelError}
        </p>
      )}

      {activeFile && (
        <LabelFilePopup
          file={activeFile}
          loading={popupLoading}
          error={popupError}
          rows={popupRows}
          onClose={closeFilePopup}
          onRetry={retryLoadFileRows}
          onRowClick={handlePopupRowClick}
        />
      )}
    </div>
  );
}
