// ==============================================================================
// App Initialization Hook
// ==============================================================================
//
// Logic for mounting the application, synchronizing session tokens,
// restoring search state from the URL, and fetching server limits.

import { useEffect } from "react";
import { useAppStore } from "../store/AppStore";
import { setApiToken, fetchLimits } from "../Api";
import { SEARCH_DEPTH_DEFAULT } from "../Constants";

export function useAppInitialization() {
  const parseDepth = (raw: string | null): number => {
    if (!raw) return SEARCH_DEPTH_DEFAULT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return SEARCH_DEPTH_DEFAULT;
    return parsed;
  };

  const initialParams = new URLSearchParams(window.location.search);
  const initialSearch = initialParams.get("search")?.trim() ?? "";
  const initialToken = initialParams.get("token")?.trim() ?? "";
  const initialDepth = parseDepth(initialParams.get("depth")?.trim() ?? null);

  useEffect(() => {
    const store = useAppStore.getState();

    // Sync search parameters from URL to store.
    useAppStore.setState({
      searchParamTxid: initialSearch,
      searchDepth: initialDepth,
    });

    // Handle authentication token (URL -> sessionStorage -> module).
    const token = initialToken || sessionStorage.getItem("cory:apiToken") || "";
    if (token) {
      setApiToken(token);
      useAppStore.setState({ apiToken: token });
      localStorage.removeItem("cory:apiToken"); // Cleanup legacy
    }

    if (initialToken) {
      const params = new URLSearchParams(window.location.search);
      params.delete("token");
      const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
      window.history.replaceState(null, "", next);
    }

    // Best-effort initialization of side panels.
    void store.refreshLabelFiles();
    void store.refreshHistory();

    void (async () => {
      try {
        const limits = await fetchLimits();
        store.setSearchDepthMax(limits.effective_default_depth);
      } catch {
        // Fallbacks in AppStore keep the UI functional if limits fail.
      }

      if (initialSearch) {
        await store.doSearch(initialSearch);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { initialSearch };
}
