# Session Notes

## Active Items

- **Node-level graph traversal is still sequential**: We now batch
  unresolved `gettxout` calls per node, but BFS frontier nodes are not
  processed in parallel yet.

- **No `txindex` capability detection**: Startup does not explicitly
  check for `txindex=1`, so some RPC failures can still appear late and
  be less actionable than they should be.

- **No block height enrichment on transactions**: `TxNode.block_height`
  remains `None` because we do not call `getblockheader` to map
  `blockhash -> height`.

- **No disk cache yet**: Caching is in-memory only; optional persistent
  cache by chain/network remains unimplemented.

- **Label import API namespace behavior is limited**:
  `/api/v1/labels/import` imports into local namespace only; there is no
  API path for caller-selected namespace imports.

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

- **GraphPanel syncs props via `useMemo` side effect**: `GraphPanel.tsx`
  calls `setNodes`/`setEdges` inside a `useMemo` to sync external props
  into React Flow's internal state. This works but is an anti-pattern —
  should use `useEffect` or a key-based remount instead.

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
