# Architecture

Cory is a local-first Bitcoin transaction ancestry explorer with BIP-329
label editing. It connects to a local Bitcoin Core node via RPC, builds
spending ancestry DAGs, and serves a localhost web UI.

## Workspace layout

```
crates/
  cory-core/     Business logic (graph, labels, RPC, cache, enrichment)
  cory/          CLI + Axum web server
    ui/          React + React Flow SPA (built by build.rs, embedded via rust-embed)
    build.rs     Runs npm install + build during cargo build
```

`cory-core` has no knowledge of HTTP or CLI concerns. `cory` depends on
`cory-core` and wires everything together.

## cory-core modules

### `types.rs` — Domain types

Core data structures independent of any RPC library:

- **`TxNode`** — A transaction in the graph. No stored `is_coinbase` or
  `confirmations` fields; both are computed methods. `is_coinbase()`
  checks for a single input with `prevout == None`.
  `confirmations(tip_height)` computes `tip - block_height + 1`.
- **`TxInput`** / **`TxOutput`** — Inputs carry an optional prevout
  `OutPoint` (None for coinbase), resolved value, and script type.
  Outputs carry value, raw `ScriptBuf`, and classified `ScriptType`.
- **`AncestryGraph`** — `HashMap<Txid, TxNode>` + `Vec<AncestryEdge>`,
  with a root txid, truncated flag, and stats.
- **`GraphLimits`** — `max_depth`, `max_nodes`, `max_edges` with
  sensible defaults (50 / 500 / 2000).
- **`RawTxInfo`**, **`RawInputInfo`**, **`RawOutputInfo`**,
  **`TxOutInfo`**, **`ChainInfo`** — Intermediate types that sit between
  the RPC response and the domain types. Owned by cory-core, not the
  RPC library.
- **`ScriptType`** — Enum: `P2pkh`, `P2sh`, `P2wpkh`, `P2wsh`, `P2tr`,
  `BareMultisig`, `OpReturn`, `Unknown`. Classification delegates to the
  `bitcoin` crate's `Script::is_p2pkh()` etc. — no manual opcode matching.

### `rpc/` — Bitcoin Core RPC

```
rpc/
  mod.rs              BitcoinRpc trait
  http_adapter.rs     Real implementation via native JSON-RPC over reqwest
  mock.rs             MockRpc for tests (behind #[cfg(test)])
```

**`BitcoinRpc`** trait has four methods:

- `get_transaction(txid)` → `RawTxInfo`
- `get_tx_out(txid, vout)` → `Option<TxOutInfo>`
- `get_tx_outs(outpoints[])` → `Vec<Option<TxOutInfo>>` (batch-friendly)
- `get_blockchain_info()` → `ChainInfo`

**`HttpRpcClient`** uses `reqwest` directly and sends JSON-RPC requests
to Bitcoin Core compatible endpoints. It parses only the fields Cory
needs and is resilient to response shape quirks (e.g. `warnings` string
vs array). For performance, it supports JSON-RPC batch requests and uses
batched `gettxout` lookups when resolving many unresolved prevouts.

**`MockRpc`** uses a builder pattern to populate a `HashMap<Txid,
RawTxInfo>` of canned transactions. Used by graph and cache tests.

### `cache.rs` — In-memory caches

Two `tokio::sync::RwLock<LruCache<...>>` maps with configurable capacity
(CLI flags `--cache-tx-cap` and `--cache-prevout-cap`):

- **Transaction cache**: `Txid → TxNode` (fully converted, enriched)
- **Prevout cache**: `(Txid, u32) → PrevoutInfo` (value + script)

Entries are evicted in least-recently-used order when the cache is full.
Shared via `Arc<Cache>` between graph builder and server.

### `graph.rs` — Ancestry DAG builder

`build_ancestry(rpc, cache, root_txid, limits, concurrency)` does a
parallel BFS from the root transaction:

1. Collect the current BFS frontier: all txids at the current depth.
2. Skip visited txids or if any limit is hit (set `truncated = true`).
3. Fetch the entire frontier in parallel via `try_join_all`, with
   concurrency gated by a semaphore.
4. Convert each `RawTxInfo` → `TxNode`, resolving prevout values/scripts.
5. For each non-coinbase input, enqueue the funding txid at `depth + 1`.
6. Record `AncestryEdge` for each input→funding relationship.
7. For spent prevouts from out-of-graph parents, attempt a fallback
   `getrawtransaction` to resolve the value and script type.

Deduplication is by `HashSet<Txid>` — if two inputs reference the same
parent tx, it appears once in the graph with two edges pointing to it.

**Prevout resolution** tries four sources in order:

1. Data from the RPC response itself (if verbosity=2 was used)
2. The prevout cache
3. The transaction cache (the funding tx may already be fetched)
4. `gettxout` RPC call (batched where possible; only works for unspent outputs)

### `enrich.rs` — Deterministic enrichments

Pure functions, no I/O:

- `classify_script(Script) → ScriptType`
- `compute_fee(TxNode) → Option<Amount>` (sum inputs − sum outputs)
- `compute_feerate(fee, vsize) → f64` (sat/vB)
- `is_rbf_signaling(TxNode) → bool` (any sequence < 0xFFFFFFFE)
- `locktime_info(locktime, has_non_final_seq) → LocktimeInfo`

### `labels/` — BIP-329 labels and label files

Module containing types, JSONL serialization, directory walking, and
the label store.

**Types:**

- `Bip329Type` — `Tx`, `Addr`, `Pubkey`, `Input`, `Output`, `Xpub`
- `Bip329Record` — type + ref + label + optional origin/spendable
- `LabelFileKind` — `PersistentRw` (editable, disk-backed),
  `PersistentRo` (read-only, disk-loaded), or `BrowserRw` (editable,
  ephemeral)
- `LabelFile` — file identity, kind, editability, optional
  `source_path` (for PersistentRw auto-flush), and label map

**`LabelStore`** holds three ordered in-memory collections:

- PersistentRw files (loaded from `--labels-rw` dirs, editable,
  auto-flushed to disk)
- BrowserRw files (created/imported from the Web UI, editable,
  ephemeral)
- PersistentRo files (loaded from `--labels-ro` dirs, read-only)

Labels are resolved in deterministic order: PersistentRw → BrowserRw →
PersistentRo. This allows editable overrides while keeping read-only
pack labels visible.

Key operations:

- `load_rw_dir(path)` — recursively load editable `.jsonl` files
- `load_ro_dir(path)` — recursively load read-only `.jsonl` files
- `list_files()` — enumerate all files in resolution order
- `get_file(file_id)` — look up any file by ID
- `create_browser_file(name)` — create empty BrowserRw file
- `import_browser_file(name, content)` — create and import JSONL
- `replace_browser_file_content(file_id, content)` — replace full file
- `remove_browser_file(file_id)` — drop BrowserRw file from memory
- `set_label(file_id, type, ref, label)` — upsert in any editable file
- `delete_label(file_id, type, ref)` — remove entry from editable file
- `export_file(file_id)` — export any file as JSONL
- `get_all_labels_for(type, ref)` — all matching labels with source
  metadata

The caller (`cory` server) wraps the store in
`Arc<RwLock<LabelStore>>` for concurrent access.

### `error.rs` — Error types

`CoreError` with `thiserror`: `Rpc`, `TxNotFound`, `InvalidTxData`,
`LabelParse`, `Io`.

## cory (CLI + server)

### `cli.rs` — Command-line arguments

Clap derive struct. Notable options:

- `--connection`, `--rpc-user`, `--rpc-pass`, `--rpc-cookie-file`
- `--rpc-requests-per-second` — optional outbound RPC request limit
- `--labels-rw` — repeatable, loads editable label directories
  (auto-flushed to disk on mutation)
- `--labels-ro` — repeatable, loads read-only label directories
- `--max-depth`, `--max-nodes`, `--max-edges` — graph limits
- `--cache-tx-cap`, `--cache-prevout-cap` — LRU cache sizes
- `--rpc-concurrency` — semaphore permits for parallel RPC calls (≥1)

### `main.rs` — Startup

1. Parse CLI, init tracing.
2. Generate a random API token for this server process.
3. Connect to Bitcoin Core RPC. **This is fatal** — if
   `get_blockchain_info()` fails, the process exits with an error.
   A best-effort `txindex` probe runs immediately after.
4. Create LRU caches and label store.
5. Load `--labels-rw` and `--labels-ro` directories.
6. Build Axum router and start server.

### `server.rs` — HTTP API

**Routes:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/health` | No | `{"status": "ok"}` |
| GET | `/api/v1/graph/tx/{txid}` | Yes | Build ancestry graph |
| GET | `/api/v1/label` | Yes | List local + pack label files |
| POST | `/api/v1/label` | Yes | Create file or import JSONL |
| POST | `/api/v1/label/{file_id}` | Yes | Upsert label or replace file content |
| DELETE | `/api/v1/label/{file_id}/entry?type=tx&ref=<txid>` | Yes | Delete one label entry from an editable file |
| DELETE | `/api/v1/label/{file_id}` | Yes | Remove browser label file |
| GET | `/api/v1/label/{file_id}/export` | Yes | Export any label file |
| GET | `/api/v1/labels.zip` | Yes | Export all browser label files as a ZIP |
| GET | `*` (fallback) | No | Serve embedded UI |

Auth is via a startup API token. Cory prints a random token at launch,
and the UI sends it in `X-API-Token` for protected routes. CORS allows
only the exact server origin.

The SPA also supports URL bootstrap params: `token` (API token) and
`search` (txid).

The graph response includes the raw `AncestryGraph` (flattened), plus
per-node `enrichments` (fee, feerate, RBF, locktime), typed labels in
`labels_by_type`, and address resolution maps:
`input_address_refs`, `output_address_refs`, and `address_occurrences`.

Three label file kinds: PersistentRw (loaded from `--labels-rw`,
editable, auto-flushed to disk), PersistentRo (loaded from
`--labels-ro`, read-only), and BrowserRw (created/imported in the
browser, editable but ephemeral). All files can be exported.

## UI

React + React Flow SPA in `crates/cory/ui/`. Built with Vite, strict
TypeScript, and ELK.js for DAG layout. Dark theme with monospace font.
No external CDN or font dependencies — fully offline.

**Stack:** React 19, @xyflow/react 12, ELK.js 0.10, Vite 6, Prettier.

**Key files:**

```
ui/src/
  main.tsx                 React root mount
  App.tsx                  Top-level layout + state orchestration
  types.ts                 API response types (mirrors Rust server)
  api.ts                   fetch helpers (graph, label files)
  layout.ts                ELK layout: graph data → React Flow nodes/edges
  index.css                Global styles (dark theme, React Flow overrides)
  components/
    Header.tsx             Brand + search bar
    GraphPanel.tsx         React Flow wrapper (nodes, edges, controls, minimap)
    TxNode.tsx             Custom node (txid/meta + input/output rows + label subtitles)
    LabelPanel.tsx         Right sidebar: pack labels, local files, selected tx editor
    SelectedTxEditor.tsx   Tx/input/output/address label editing for current node
    TargetLabelEditor.tsx  Reusable target-scoped label editor card
```

**Features:**

- Txid search → interactive DAG visualization with ELK layered layout
- Click a node to select it → sidebar shows selected-transaction editor
- Create/import/remove local label files (POST/DELETE with `X-API-Token` auth)
- Edit `tx`, `input`, `output`, and derived `addr` labels from the selected transaction editor
- Address labels are shared by address string (reused addresses map to one label target)
- Delete one label entry from a local file (DELETE entry endpoint)
- Export per-file BIP-329 JSONL
- Export all browser label files as a single ZIP download
- Drag nodes, zoom, pan, minimap, fit-to-view controls, and resize the right sidebar

**Build integration:**

- `crates/cory/build.rs` runs `npm ci && npm run build` during
  `cargo build`, with `[ui]`-prefixed status logging and hash-based
  skip to avoid unnecessary rebuilds.
- If npm is unavailable, the build succeeds and the server returns
  "UI not built" at runtime.
- `rust-embed` embeds `ui/dist/` into the binary. In debug builds,
  files are read from the filesystem; in release builds, they are
  baked in.
- `mime_guess` sets correct `Content-Type` headers for each asset.
- SPA fallback: unmatched paths serve `index.html`.

**Dev workflow:**

1. Terminal 1: `cargo run` (Rust server on `:3080`)
2. Terminal 2: `cd crates/cory/ui && npm run dev` (Vite HMR on `:5173`)
3. Vite proxies `/api` to the Rust server.

## Regtest integration flows

Integration tests that require a live Bitcoin Core node are ignored by
default and are driven by Python runners under `scripts/`.

- `scripts/common.py` provides shared regtest lifecycle helpers
  (bitcoind startup, `bitcoin-cli` wrapper, env wiring, and ignored test
  invocation).
- `scripts/regtest/rpc_e2e.py` provisions a temporary node, generates RPC
  fixture files in `tmp/`, and executes `tests/regtest_rpc.rs`.
- `scripts/regtest/graph.py` provisions deterministic graph scenarios,
  writes a JSON fixture in `tmp/`, and executes `tests/regtest_graph.rs`.
- `scripts/regtest/server_e2e.py` provisions a fixture transaction, starts
  a live `cory` server process, writes a server fixture in `tmp/`, and
  executes `crates/cory/tests/regtest_server.rs`.
- `scripts/ui/manual_fixtures.py` is a manual UI workflow (not an automated
  test): it builds richer scenario catalogs for human exploration, starts
  `bitcoind` + `cory`, and writes `tmp/ui_manual_fixture-*.json` containing
  `schema_version`, `run_id`, `server_url`, and scenario records
  (`name`, `description`, `root_txid`, `related_txids`, `suggested_ui_checks`).

Graph scenarios are split into two tiers:

- Functional coverage: small chain, merge/dedup behavior, wide frontier,
  depth/node/edge truncation, and spent-prevout resolution gaps.
- Stress coverage: deep, wide, and merge-heavy graphs with large
  topologies (default target is 500 transactions per stress scenario).
- Server coverage: all `server.rs` routes including auth failures,
  browser label file CRUD, per-entry label delete, static fallback,
  and exact-origin CORS.

Because Bitcoin UTXO ancestry is acyclic by construction, the stress
suite uses dense merge and frontier patterns rather than true cycle
fixtures.

## Known quirks and remaining limitations

### Block height resolution costs extra RPCs

When `getrawtransaction` does not include `blockheight`, the HTTP RPC
adapter resolves it from `blockhash` via `getblockheader` and caches the
mapping in-memory. Heights are now populated, but this introduces extra
RPC traffic for previously unseen block hashes.

### `version` field compatibility

Bitcoin Core returns version as a signed integer. The HTTP adapter parses
it as `i32` directly so negative versions are preserved.

### Output-to-child vertical order may not match `vout`

The UI uses ELK layered layout with crossing minimization. For fan-out
patterns, ELK may still place child transactions in a vertical order that
does not match the parent's output index order (`vout 0`, `vout 1`, ...),
including simple cases. This can produce avoidable-looking crossings even
when edges are routed to the correct output handles.
