import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { middleEllipsize } from "../../utils/Format";

interface MiddleEllipsisTextProps {
  text: string;
  title?: string;
  style?: CSSProperties;
}

export const MiddleEllipsisText = memo(function MiddleEllipsisText({
  text,
  title,
  style,
}: MiddleEllipsisTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [font, setFont] = useState("11px monospace");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      setAvailableWidth(el.clientWidth);
      const computed = getComputedStyle(el).font;
      if (computed) setFont(computed);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const display = useMemo(
    () => middleEllipsize(text, availableWidth, font),
    [text, availableWidth, font],
  );

  return (
    <span
      ref={ref}
      style={{
        ...style,
        display: "block",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={title ?? text}
    >
      {display}
    </span>
  );
});
