# Session Notes

## Active Items

- **Node-level graph traversal is still sequential**: We now batch
  unresolved `gettxout` calls per node, but BFS frontier nodes are not
  processed in parallel yet.

- **No `txindex` capability detection**: Startup does not explicitly
  check for `txindex=1`, so some RPC failures can still appear late and
  be less actionable than they should be.

- **Architecture docs are stale vs implementation**: `docs/ARCHITECTURE.md`
  still describes tx-only graph labels, old UI inline label editing, and
  old graph response fields (`labels`) that were replaced by typed maps
  and address-ref maps.

- **No disk cache yet**: Caching is in-memory only; optional persistent
  cache by chain/network remains unimplemented.

- **Cycle scenarios are not representable for ancestry graphs**:
  Bitcoin's UTXO model is acyclic, so integration stress coverage should
  focus on merge-heavy and wide/deep DAG shapes instead of true cycles.

- **CORS disallowed-origin behavior is mismatch-based, not header-absent**:
  The server may still emit `access-control-allow-origin` with the
  configured exact origin even when request `Origin` differs; browsers
  block because the value does not match the requesting origin.

- **Manual RBF fixture depends on node policy**:
  The UI manual fixture workflow assumes BIP125 replacement acceptance;
  non-default mempool policy toggles may cause the replacement step to
  fail even though the script correctly signals opt-in RBF.

- **Vite bundle size warning**: The production JS bundle is ~1.8 MB
  (562 KB gzipped), mostly ELK.js. Could be reduced with dynamic
  `import()` to code-split ELK from the React bundle.

- **No Prettier config file**: Prettier uses defaults (double quotes,
  no trailing commas config, etc.). A `.prettierrc` may be needed if
  the default style diverges from preferences.

- **`build.rs` re-runs npm on some no-op rebuilds**: Cargo may
  re-trigger the build script even when no UI files changed, because
  `npm install` can touch `package-lock.json` timestamps. A hash-based
  check could avoid this.

- **ELK node height is fixed while label editors are variable-height**:
  `layout.ts` uses static `NODE_HEIGHT`, so transactions with many label
  rows in-node may visually overlap nearby edges/nodes until dynamic
  sizing or post-render relayout is added.

- **Node render model is duplicated in `layout.ts`**: Height estimation and
  per-node data construction are now spread across multiple passes; this
  raises maintenance risk and should be consolidated behind one builder.

- **Node handle positioning is O(n^2) per node render**: `TxNode.tsx` computes
  cumulative row offsets via repeated `slice(...).reduce(...)`; should be
  replaced with a single prefix-sum pass for large rows.

- **In-place node refresh skips relayout after label growth**: Preserving
  zoom/pan and node positions avoids jarring resets, but tall label growth
  can still cause local overlaps because ELK is not rerun on label updates.

- **Right sidebar width is session-local only**: Drag-resize is implemented
  in memory and resets on reload; width persistence (e.g. localStorage) is
  still missing.

- **Address-label warning copy is easy to misread**: The warning says updates
  are matched \"across all addresses\", but behavior is per-address-ref across
  occurrences; wording should be tightened to avoid user confusion.

- **Very small label subtitle typography harms readability**: Node subtitles
  now use tiny font sizes (7-9px) to fit density; needs a UX pass for
  accessibility and legibility balance.
