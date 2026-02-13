# Session Notes

## Active Items

- **No disk cache persistence**: LRU caching is in-memory only with
  configurable capacity (`--cache-tx-cap`, `--cache-prevout-cap`).
  Optional on-disk cache persistence by chain/network remains
  unimplemented.

- **Block height resolution costs extra RPCs**: When `getrawtransaction`
  does not include `blockheight`, the adapter resolves it via
  `getblockheader` and caches the mapping. This adds per-block-hash
  RPC traffic.
