import { useState, useCallback } from "react";
import { Search } from "lucide-react";
import { useAppStore } from "../store";

interface HeaderProps {
  initialTxid?: string;
}

export default function Header({ initialTxid = "" }: HeaderProps) {
  const [txid, setTxid] = useState(initialTxid);
  const doSearch = useAppStore((s) => s.doSearch);
  const apiToken = useAppStore((s) => s.apiToken);
  const authError = useAppStore((s) => s.authError);
  const setApiToken = useAppStore((s) => s.setApiToken);

  const handleSearch = useCallback(() => {
    const trimmed = txid.trim();
    if (trimmed) doSearch(trimmed);
  }, [txid, doSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSearch();
    },
    [handleSearch],
  );

  return (
    <header
      className="panel"
      style={{
        padding: "12px 20px",
        borderRadius: 0,
        borderLeft: "none",
        borderRight: "none",
        borderTop: "none",
        borderBottom: "1px solid var(--border-subtle)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div
        aria-label="Cory"
        role="img"
        style={{
          alignSelf: "stretch",
          height: "100%",
          aspectRatio: "271.61 / 101.03",
          backgroundColor: "var(--accent)",
          WebkitMaskImage: "url('/img/logo_mini.svg')",
          maskImage: "url('/img/logo_mini.svg')",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
          flexShrink: 0,
        }}
      />

      <div style={{ display: "flex", gap: 8, flex: 1, minWidth: 300 }}>
        <input
          type="text"
          value={txid}
          onChange={(e) => setTxid(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter a txid to explore its spending ancestry..."
          spellCheck={false}
          style={{ flex: 1, fontFamily: "var(--mono)" }}
        />
        <button
          className="btn-primary"
          onClick={handleSearch}
          title="Search txid"
          aria-label="Search txid"
        >
          <Search size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div
        className="panel-elevated"
        style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, minWidth: 350 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ color: "var(--text-muted)", fontSize: 11 }}>API Token:</label>
          <input
            type="text"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="paste token from terminal"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: 320,
              fontSize: 11,
              fontFamily: "var(--mono)",
              background: "var(--surface-1)",
            }}
          />
        </div>
        {authError && (
          <div className="text-error" style={{ fontSize: 10, maxWidth: 340 }}>
            {authError}
          </div>
        )}
      </div>
    </header>
  );
}
