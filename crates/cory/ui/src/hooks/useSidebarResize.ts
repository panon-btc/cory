import { useState, useCallback } from "react";
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH } from "../constants";

const STORAGE_KEY = "cory:sidebarWidth";

function clamp(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

// Manages the sidebar width with mouse-drag resizing and localStorage
// persistence. Returns the current width and a mousedown handler to
// attach to the resize separator element.
export function useSidebarResize(): {
  width: number;
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

  const onResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        setWidth(clamp(startWidth - deltaX));
      };

      const onMouseUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        const finalWidth = clamp(startWidth - (upEvent.clientX - startX));
        localStorage.setItem(STORAGE_KEY, String(finalWidth));
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [width],
  );

  return { width, onResizeStart };
}
