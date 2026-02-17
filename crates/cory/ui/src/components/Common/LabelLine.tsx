interface LabelLineProps {
  label: string;
  style?: React.CSSProperties;
}

export function LabelLine({ label, style }: LabelLineProps) {
  return (
    <div
      style={{
        color: "var(--text-muted)",
        fontSize: 9,
        fontStyle: "italic",
        lineHeight: 1.1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: "100%",
        ...style,
      }}
      title={label}
    >
      {label}
    </div>
  );
}
