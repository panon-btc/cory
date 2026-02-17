// ==============================================================================
// URL Navigation Helpers
// ==============================================================================
//
// Shared logic for synchronizing application state with URL search parameters.

export function replaceUrlSearchParams(search: string, depth: number): void {
  const searchTrimmed = search.trim();
  const parts: string[] = [];

  if (searchTrimmed) {
    parts.push(`search=${encodeURIComponent(searchTrimmed)}`);
    parts.push(`depth=${encodeURIComponent(String(depth))}`);
  }

  const next = `${window.location.pathname}${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) {
    window.history.replaceState(null, "", next);
  }
}
