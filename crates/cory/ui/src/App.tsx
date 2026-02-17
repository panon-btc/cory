// ==============================================================================
// Main Application Component
// ==============================================================================
//
// Root layout component that coordinates the graph visualization,
// header, and sidebar panels. Logic is delegated to specialized hooks.

import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Toaster } from "react-hot-toast";

import { useAppStore } from "./store/AppStore";
import { useSidebarResize } from "./hooks/UseSidebarResize";
import { useThemeMode } from "./hooks/UseThemeMode";
import { useAppInitialization } from "./hooks/UseAppInitialization";

import Header from "./components/Header";
import GraphPanel from "./components/GraphPanel";
import LabelPanel from "./components/LabelPanel/LabelPanel";
import { SidebarHandle } from "./components/SidebarHandle";

export default function App() {
  const { initialSearch } = useAppInitialization();
  const { themeMode, toggleThemeMode } = useThemeMode();
  const graph = useAppStore((s) => s.graph);
  const triggerRelayout = useAppStore((s) => s.triggerRelayout);

  const {
    width: sidebarWidth,
    isOpen: isSidebarOpen,
    openSidebar,
    closeSidebar,
    onResizeStart: handleSidebarResizeStart,
  } = useSidebarResize();

  // Relayout when graph change detected (e.g. from height-impacting label edits).
  useEffect(() => {
    if (graph) {
      triggerRelayout();
    }
  }, [graph, triggerRelayout]);

  return (
    <ReactFlowProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Header initialTxid={initialSearch} />
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <GraphPanel />
          <SidebarHandle
            isSidebarOpen={isSidebarOpen}
            onResizeStart={handleSidebarResizeStart}
            openSidebar={openSidebar}
          />
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
