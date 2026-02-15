import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useAppStore, relayoutIfHeightsChanged } from "./store";
import { setApiToken } from "./api";
import { useSidebarResize } from "./hooks/useSidebarResize";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/label_panel/Panel";

export default function App() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialSearch = initialParams.get("search")?.trim() ?? "";
  const initialToken = initialParams.get("token")?.trim() ?? "";

  const { width: sidebarWidth, onResizeStart: handleSidebarResizeStart } = useSidebarResize();
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
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleSidebarResizeStart}
            style={{
              width: 6,
              cursor: "col-resize",
              background: "var(--border)",
              opacity: 0.45,
            }}
            title="Drag to resize panel"
          />
          <LabelPanel width={sidebarWidth} />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
