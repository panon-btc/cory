import { useState, useCallback } from "react";
import {
  SIDEBAR_COLLAPSE_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../Constants";

const STORAGE_KEY = "cory:sidebarWidth";
const OPEN_STORAGE_KEY = "cory:sidebarOpen";

function clamp(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

// Manages the sidebar width with mouse-drag resizing and localStorage
// persistence. Returns the current width and a mousedown handler to
// attach to the resize separator element.
export function useSidebarResize(): {
  width: number;
  isOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
} {
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = parseInt(stored, 10);
      if (!isNaN(n) && n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) return n;
    }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const [isOpen, setIsOpen] = useState(() => localStorage.getItem(OPEN_STORAGE_KEY) !== "0");

  const openSidebar = useCallback(() => {
    setIsOpen(true);
    localStorage.setItem(OPEN_STORAGE_KEY, "1");
  }, []);

  const closeSidebar = useCallback(() => {
    setIsOpen(false);
    localStorage.setItem(OPEN_STORAGE_KEY, "0");
  }, []);

  const onResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      let collapsedByDrag = false;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = startWidth - deltaX;

        if (nextWidth <= SIDEBAR_COLLAPSE_WIDTH) {
          collapsedByDrag = true;
          setIsOpen(false);
          return;
        }

        setIsOpen(true);
        setWidth(clamp(nextWidth));
      };

      const onMouseUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);

        if (collapsedByDrag || startWidth - (upEvent.clientX - startX) <= SIDEBAR_COLLAPSE_WIDTH) {
          setIsOpen(false);
          localStorage.setItem(OPEN_STORAGE_KEY, "0");
          return;
        }

        const finalWidth = clamp(startWidth - (upEvent.clientX - startX));
        setIsOpen(true);
        localStorage.setItem(OPEN_STORAGE_KEY, "1");
        localStorage.setItem(STORAGE_KEY, String(finalWidth));
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [width],
  );

  return { width, isOpen, openSidebar, closeSidebar, onResizeStart };
}
