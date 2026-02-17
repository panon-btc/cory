// ==============================================================================
// Auth Store Slice
// ==============================================================================

import { type StateCreator } from "zustand";
import { type AppState } from "./AppStore";
import { errorMessage, isAuthError, setApiToken as setApiTokenInModule } from "../Api";

export interface AuthSlice {
  apiToken: string;
  authError: string | null;
  setAuthError: (message: string | null) => void;
  handleAuthError: (err: unknown) => boolean;
  setApiToken: (token: string) => void;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set) => ({
  apiToken: "",
  authError: null,

  setAuthError: (message) => set({ authError: message }),

  handleAuthError: (err) => {
    if (!isAuthError(err)) return false;
    set({ authError: errorMessage(err, "request failed") });
    return true;
  },

  setApiToken: (token) => {
    const trimmed = token.trim();
    set({ apiToken: trimmed, authError: null });
    if (trimmed) {
      sessionStorage.setItem("cory:apiToken", trimmed);
    } else {
      sessionStorage.removeItem("cory:apiToken");
    }
    setApiTokenInModule(trimmed);
  },
});
