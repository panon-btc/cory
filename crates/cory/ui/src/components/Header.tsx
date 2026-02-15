import { useState, useCallback } from "react";
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
      if (e.key === "Enter") {
        const trimmed = txid.trim();
        if (trimmed) doSearch(trimmed);
      }
    },
    [txid, doSearch],
  );

  return (
    <header
      style={{
        padding: "12px 20px",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <h1 style={{ fontSize: 16, color: "var(--accent)", margin: 0 }}>Cory</h1>

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
        <button onClick={handleSearch}>Search</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ color: "var(--text-muted)", fontSize: 11 }}>API Token:</label>
          <input
            type="text"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="paste token from terminal"
            autoComplete="off"
            spellCheck={false}
            style={{ width: 320, fontSize: 11, fontFamily: "var(--mono)" }}
          />
        </div>
        {authError && (
          <div style={{ color: "var(--warning)", fontSize: 10, maxWidth: 340 }}>{authError}</div>
        )}
      </div>
    </header>
  );
}
