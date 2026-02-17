import { copyToClipboard } from "../../utils/Format";

interface CopyButtonProps {
  value: string;
  onCopied: (value: string) => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function CopyButton({
  value,
  onCopied,
  title,
  children,
  className,
  style,
}: CopyButtonProps) {
  return (
    <button
      type="button"
      className={`nodrag nopan ${className || ""}`}
      onClick={() => {
        void copyToClipboard(value).then((copied) => {
          if (copied) {
            onCopied(value);
          }
        });
      }}
      title={title || `Copy: ${value}`}
      style={{
        color: "var(--accent)",
        minWidth: 24,
        border: "none",
        background: "transparent",
        padding: 0,
        textAlign: "left",
        font: "inherit",
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
