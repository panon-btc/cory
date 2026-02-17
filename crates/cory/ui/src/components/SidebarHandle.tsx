// ==============================================================================
// Sidebar Handle Component
// ==============================================================================
//
// The interactive divider between the main graph and the sidebar.
// Handles resizing, collapsing, and accessibility interactions.

interface SidebarHandleProps {
  isSidebarOpen: boolean;
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
  openSidebar: () => void;
}

export function SidebarHandle({ isSidebarOpen, onResizeStart, openSidebar }: SidebarHandleProps) {
  return (
    <div
      className={`resize-handle ${isSidebarOpen ? "" : "resize-handle-collapsed"}`.trim()}
      role={isSidebarOpen ? "separator" : "button"}
      aria-orientation={isSidebarOpen ? "vertical" : undefined}
      onMouseDown={onResizeStart}
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
  );
}
