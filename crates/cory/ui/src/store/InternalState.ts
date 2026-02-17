// ==============================================================================
// Internal Store State (Module Scope)
// ==============================================================================
//
// This object acts as a shared singleton across store slices. Because it is
// imported by multiple slices from the same module, it allows them to
// coordinate non-reactive state (like search abort controllers and race-condition
// guards) without triggering React re-renders or polluting the reactive store.

export const internalState = {
  searchAbortController: null as AbortController | null,
  searchId: 0,
  lastSearchTxid: "",
};
