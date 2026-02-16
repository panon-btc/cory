import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Toaster } from "react-hot-toast";
import { useAppStore, relayoutIfHeightsChanged } from "./store";
import { setApiToken } from "./api";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useThemeMode } from "./hooks/useThemeMode";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/label_panel/Panel";

export default function App() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialSearch = initialParams.get("search")?.trim() ?? "";
  const initialToken = initialParams.get("token")?.trim() ?? "";

  const {
    width: sidebarWidth,
    isOpen: isSidebarOpen,
    openSidebar,
    closeSidebar,
    onResizeStart: handleSidebarResizeStart,
  } = useSidebarResize();
  const { themeMode, toggleThemeMode } = useThemeMode();
  const graph = useAppStore((s) => s.graph);

  // On mount: sync API token, load label files, and kick off the initial
  // search from the URL param. All three are independent, fire-and-forget
  // operations that only need to run once.
  useEffect(() => {
    const token = initialToken || localStorage.getItem("cory:apiToken") || "";
    if (token) {
      setApiToken(token);
      useAppStore.setState({ apiToken: token, searchParamTxid: initialSearch });
      localStorage.setItem("cory:apiToken", token);
    }

    void useAppStore.getState().refreshLabelFiles();
    void useAppStore.getState().refreshHistory();

    if (initialSearch) {
      void useAppStore.getState().doSearch(initialSearch);
    }
    // Intentionally empty: all values come from URL params parsed once at
    // module evaluation time. Re-running on changes would cause loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relayout when graph changes (label edits change node heights).
  useEffect(() => {
    if (graph) {
      relayoutIfHeightsChanged(graph);
    }
  }, [graph]);

  return (
    <ReactFlowProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Header initialTxid={initialSearch} />
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <GraphPanel />
          <div
            className={`resize-handle ${isSidebarOpen ? "" : "resize-handle-collapsed"}`.trim()}
            role={isSidebarOpen ? "separator" : "button"}
            aria-orientation={isSidebarOpen ? "vertical" : undefined}
            // One drag interaction handles both states:
            // - open panel: resize/collapse
            // - collapsed panel: drag-left to reopen + resize
            onMouseDown={handleSidebarResizeStart}
            onKeyDown={
              isSidebarOpen
                ? undefined
                : (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openSidebar();
                    }
                  }
            }
            tabIndex={isSidebarOpen ? undefined : 0}
            aria-label={isSidebarOpen ? "Resize label panel" : "Open label panel"}
            style={{
              width: isSidebarOpen ? 6 : 16,
              cursor: isSidebarOpen ? "col-resize" : "pointer",
              opacity: isSidebarOpen ? 0.45 : 0.75,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              userSelect: "none",
            }}
            title={
              isSidebarOpen
                ? "Drag left to resize. Drag far left to collapse panel."
                : "Click to open label panel"
            }
          >
            {!isSidebarOpen && "‹"}
          </div>
          {isSidebarOpen && (
            <LabelPanel
              width={sidebarWidth}
              onClose={closeSidebar}
              themeMode={themeMode}
              onToggleThemeMode={toggleThemeMode}
            />
          )}
        </div>
      </div>
      <Toaster
        position="bottom-center"
        toastOptions={{
          duration: 2000,
          style: {
            background: "#000",
            color: "#fff",
            fontFamily: "var(--mono)",
            fontSize: "11px",
            borderRadius: "6px",
            maxWidth: "min(calc(100vw - 24px), 720px)",
          },
        }}
      />
    </ReactFlowProvider>
  );
}
