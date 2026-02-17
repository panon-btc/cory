import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Toaster } from "react-hot-toast";
import { useAppStore, relayoutIfHeightsChanged } from "./store";
import { fetchLimits, setApiToken } from "./api";
import { SEARCH_DEPTH_DEFAULT } from "./constants";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useThemeMode } from "./hooks/useThemeMode";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/label_panel/Panel";

export default function App() {
  const parseDepth = (raw: string | null): number => {
    if (!raw) return SEARCH_DEPTH_DEFAULT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return SEARCH_DEPTH_DEFAULT;
    return parsed;
  };

  const initialParams = new URLSearchParams(window.location.search);
  const initialSearch = initialParams.get("search")?.trim() ?? "";
  const initialToken = initialParams.get("token")?.trim() ?? "";
  const initialDepth = parseDepth(initialParams.get("depth")?.trim() ?? null);

  const {
    width: sidebarWidth,
    isOpen: isSidebarOpen,
    openSidebar,
    closeSidebar,
    onResizeStart: handleSidebarResizeStart,
  } = useSidebarResize();
  const { themeMode, toggleThemeMode } = useThemeMode();
  const graph = useAppStore((s) => s.graph);

  // On mount: sync token, restore URL search params, refresh side panels,
  // then fetch server limits before the initial search so depth clamping
  // is consistent with backend hard caps.
  useEffect(() => {
    useAppStore.setState({ searchParamTxid: initialSearch, searchDepth: initialDepth });
    const token = initialToken || sessionStorage.getItem("cory:apiToken") || "";
    if (token) {
      setApiToken(token);
      useAppStore.setState({ apiToken: token });
      // Cleanup legacy storage from pre-hardening builds.
      localStorage.removeItem("cory:apiToken");
    }

    if (initialToken) {
      const params = new URLSearchParams(window.location.search);
      params.delete("token");
      const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
      window.history.replaceState(null, "", next);
    }

    void useAppStore.getState().refreshLabelFiles();
    void useAppStore.getState().refreshHistory();

    void (async () => {
      try {
        const limits = await fetchLimits();
        useAppStore.getState().setSearchDepthMax(limits.hard_max_depth);
      } catch {
        // Limits are non-critical; the store fallback max keeps search usable.
      }

      if (initialSearch) {
        await useAppStore.getState().doSearch(initialSearch);
      }
    })();
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
