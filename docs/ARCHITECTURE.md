# Architecture

Cory is a local-first Bitcoin transaction ancestry explorer with BIP-329
label editing. It connects to a Bitcoin Core RPC endpoint, builds ancestry
graphs, and serves a localhost web UI.

This document is intentionally high-level. API/type member-level details
should live in code docs and rustdoc/docs.rs.

## Workspace Overview

```
crates/
  cory-core/   Domain logic, graph building, RPC adapter, labels, caching
  cory/        CLI + Axum server + embedded SPA serving
    ui/        React/Vite SPA
    build.rs   UI build orchestration for Cargo builds
```

Design boundary:
- `cory-core` is transport-agnostic business logic.
- `cory` wires runtime concerns (CLI, HTTP, auth, CORS, static assets).

## Runtime Flow

Server startup:
1. Parse CLI flags.
2. Create a session API token.
3. Connect to Bitcoin Core via `getblockchaininfo` (fatal on failure).
4. Initialize in-memory caches and label store.
5. Load `--labels-rw` and `--labels-ro` directories.
6. Start Axum router and serve UI + API.

Graph request flow (`GET /api/v1/graph/tx/{txid}`):
1. Validate auth token and txid.
2. Validate query overrides (`max_depth`, `max_nodes`, `max_edges`), rejecting
   zero values.
3. Build ancestry graph via `cory-core::graph::build_ancestry`.
4. Enrich graph response with fee/feerate/RBF/locktime and labels.
5. Record search history (bounded in-memory set with eviction).

## Core Components (`cory-core`)

- `rpc`: `BitcoinRpc` trait + HTTP JSON-RPC adapter + test mock.
- `graph`: parallel BFS ancestry builder with configurable limits and
  truncation signaling.
- `cache`: in-memory LRU caches for transactions and prevouts.
- `labels`: BIP-329 parsing/import/export and label file store.
- `enrich`: deterministic enrichments (script type, fee, feerate, RBF,
  locktime).
- `error`: typed core errors (`TxNotFound`, RPC, parse/data errors, I/O).

Key behavior:
- Not-found transaction RPC failures are normalized to `CoreError::TxNotFound`.
- Prevout resolution uses layered fallbacks (response data, cache, `gettxout`,
  parent transaction lookup) with warning logs on fallback RPC failures.

## Server Components (`cory`)

- `main.rs`: startup orchestration and API token printing.
- `server/`: router, auth, graph/history handlers, label handlers, static file
  serving, HTTP error mapping.

### HTTP Surface

Public:
- `GET /api/v1/health`

Protected (require `X-API-Token`):
- `GET /api/v1/graph/tx/{txid}`
- `GET /api/v1/history`
- `GET/POST /api/v1/label`
- `POST/DELETE /api/v1/label/{file_id}`
- `DELETE /api/v1/label/{file_id}/entry`
- `GET /api/v1/label/{file_id}/export`
- `GET /api/v1/labels.zip`

Fallbacks:
- `/api` and `/api/{*path}` return JSON `404`.
- Non-API unmatched routes serve SPA `index.html`.

### Error Semantics

Graph endpoint maps core failures into HTTP classes:
- `TxNotFound` -> `404`
- invalid transaction data/shape -> `400`
- upstream Bitcoin RPC failures -> `502`
- unexpected internal failures -> `500`

## UI Architecture (`crates/cory/ui`)

Stack:
- React 19 + Zustand state store
- React Flow for rendering graph
- ELK.js for graph layout
- Vite build pipeline

State and auth behavior:
- API token is sent via `X-API-Token`.
- `?token=` is supported as one-time bootstrap input.
- Token is removed from URL after bootstrap and persisted to `sessionStorage`
  (not `localStorage`).
- URL synchronization keeps `search` state, not auth token.

UI capabilities:
- txid search and ancestry graph visualization
- node selection + label editing (`tx`, `input`, `output`, derived `addr`)
- label file create/import/export/delete flows
- combined browser-label ZIP export
- in-app search history panel sourced from `/api/v1/history`

## Label Model

Three label file kinds:
- `PersistentRw`: disk-backed, editable, auto-flushed on mutation.
- `PersistentRo`: disk-backed, read-only.
- `BrowserRw`: editable in memory for browser session workflows.

Resolution order (highest priority first):
1. `PersistentRw`
2. `BrowserRw`
3. `PersistentRo`

`/api/v1/label` lists all file kinds in resolution order.

## Build and Packaging

`crates/cory/build.rs` orchestrates UI builds during Cargo builds:
- Runs `npm ci` and `npm run build` when UI sources change.
- Release profile requires a successful UI build by default.
- `CORY_REQUIRE_UI=1` always requires UI build success.
- `CORY_REQUIRE_UI=0` makes UI build optional.

UI assets are embedded with `rust-embed` from `ui/dist`.

## Testing Strategy

- Rust unit tests in `cory-core` and `cory`.
- Regtest-backed integration tests are ignored by default and run via
  Python scripts in `scripts/regtest/`.
- UI/manual fixture and Playwright workflows live under `scripts/ui/`.

This split keeps default test runs fast while preserving realistic
end-to-end coverage paths for CI and local verification.
