// ==============================================================================
// useAutosave — Debounced Auto-Save Hook
// ==============================================================================
//
// Manages a draft value that auto-saves after a period of silence.
//
// State machine:
//
//   ┌────────┐  user types   ┌───────┐  debounce expires  ┌────────┐
//   │ saved  │ ────────────► │ dirty │ ──────────────────► │ saving │
//   └────────┘               └───────┘                     └────┬───┘
//       ▲                        ▲                              │
//       │   save succeeds        │      save fails              │
//       └────────────────────────┴──────────────────────────────┘
//                                                        (→ error)
//
// The `savingRef` guard prevents overlapping saves. While a save is
// in-flight, new "dirty" transitions are tracked but won't trigger
// another save until the current one finishes. The next effect cycle
// after completion will pick up any remaining dirty state.

import { useState, useEffect, useRef } from "react";
import { AUTOSAVE_DEBOUNCE_MS } from "../constants";

export type SaveState = "saved" | "dirty" | "saving" | "error";

// Auto-save a draft string value after the user stops typing.
//
// - `draft`: the current text to save (trimmed before saving)
// - `active`: whether autosave is enabled (false disables the effect)
// - `onSave`: async callback to persist the value
//
// Returns the current save state and any error message.
export function useAutosave(
  draft: string,
  active: boolean,
  onSave: (value: string) => Promise<void>,
): { state: SaveState; error: string | null; setState: (s: SaveState) => void } {
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!active || state !== "dirty" || savingRef.current) return;

    const trimmed = draft.trim();
    if (!trimmed) return;

    const timer = window.setTimeout(() => {
      savingRef.current = true;
      setState("saving");
      void onSave(trimmed)
        .then(() => {
          setError(null);
          setState("saved");
        })
        .catch((err) => {
          setError((err as Error).message);
          setState("error");
        })
        .finally(() => {
          savingRef.current = false;
        });
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [active, draft, state, onSave]);

  return { state, error, setState };
}
