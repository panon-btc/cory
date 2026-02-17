let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined =
  undefined;

function getMeasureContext() {
  if (measureCtx !== undefined) return measureCtx;

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
    return measureCtx;
  }

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(1, 1);
    measureCtx = canvas.getContext("2d");
    return measureCtx;
  }

  measureCtx = null;
  return measureCtx;
}

export function measureTextWidth(text: string, font: string): number {
  const ctx = getMeasureContext();
  if (!ctx) {
    // Keep a deterministic fallback if canvas is unavailable.
    return text.length * 7;
  }
  ctx.font = font;
  return ctx.measureText(text).width;
}
