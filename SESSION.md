# Session Notes

## Active Items

- **No disk cache persistence**: LRU caching is in-memory only with
  configurable capacity (`--cache-tx-cap`, `--cache-prevout-cap`).
  Optional on-disk cache persistence by chain/network remains
  unimplemented.

- **`list_local_label_files` naming drift**: Server handler
  `list_local_label_files` currently returns `LabelStore::list_files()`
  (local + pack), not just local files. Behavior is likely intentional,
  but naming/API docs should be aligned to avoid confusion.

- **Txindex probe comments mismatch implementation**: `check_txindex_available`
  comments mention probing a known confirmed transaction/genesis coinbase,
  but implementation uses a dummy txid ending in `...0001` and treats
  "not found" as inconclusive. Either comments or probe strategy should
  be tightened.

- **Block height resolution costs extra RPCs**: When `getrawtransaction`
  does not include `blockheight`, the adapter resolves it via
  `getblockheader` and caches the mapping. This adds per-block-hash
  RPC traffic.

- **Token in URL leaks via history/logs**: Supporting `?token=` improves
  bootstrap UX but can expose the API token in browser history and copied
  links if users share full URLs.

- *UI build currently emits a large chunk warning* (`dist/assets/elk.bundled-*.js` and main bundle exceed Vite's 500kB warning threshold); consider code splitting/manual chunks if startup size matters.
