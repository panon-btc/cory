import { useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useAppStore, relayoutIfHeightsChanged } from "./store";
import { setApiToken } from "./api";
import { useSidebarResize } from "./hooks/useSidebarResize";
import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/LabelPanel";

export default function App() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialSearch = initialParams.get("search")?.trim() ?? "";
  const initialToken = initialParams.get("token")?.trim() ?? "";

  const { width: sidebarWidth, onResizeStart: handleSidebarResizeStart } = useSidebarResize();
  const graph = useAppStore((s) => s.graph);
  const ranInitialSearchRef = useRef(false);

  // Sync API token from URL or localStorage on mount.
  useEffect(() => {
    const token = initialToken || localStorage.getItem("cory:apiToken") || "";
    if (token) {
      // Seed the api module and store without triggering a URL rewrite
      // loop — the URL already contains the token.
      setApiToken(token);
      useAppStore.setState({ apiToken: token, searchParamTxid: initialSearch });
      localStorage.setItem("cory:apiToken", token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load label files on mount.
  useEffect(() => {
    void useAppStore.getState().refreshLabelFiles();
  }, []);

  // Kick off the initial search from the URL param.
  useEffect(() => {
    if (ranInitialSearchRef.current) return;
    ranInitialSearchRef.current = true;
    if (initialSearch) {
      void useAppStore.getState().doSearch(initialSearch);
    }
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
