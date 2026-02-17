// ==============================================================================
// Zustand Store — Composed
// ==============================================================================
//
// Central state store for Cory UI. Composed from specialized slices to
// keep logic modular and file sizes manageable.

import { create } from "zustand";
import { createAuthSlice, type AuthSlice } from "./AuthSlice";
import { createLabelSlice, type LabelSlice } from "./LabelSlice";
import { createGraphSlice, type GraphSlice } from "./GraphSlice";

// The combined application state type.
export type AppState = AuthSlice & LabelSlice & GraphSlice;

export const useAppStore = create<AppState>()((...a) => ({
  ...createAuthSlice(...a),
  ...createLabelSlice(...a),
  ...createGraphSlice(...a),
}));
