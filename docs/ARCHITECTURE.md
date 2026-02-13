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
  `OpReturn`, `Unknown`. Classification delegates to the `bitcoin`
  crate's `Script::is_p2pkh()` etc. — no manual opcode matching.

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

Two `tokio::sync::RwLock<HashMap<...>>` maps:

- **Transaction cache**: `Txid → TxNode` (fully converted, enriched)
- **Prevout cache**: `(Txid, u32) → PrevoutInfo` (value + script)

Shared via `Arc<Cache>` between graph builder and server.

### `graph.rs` — Ancestry DAG builder

`build_ancestry(rpc, cache, root_txid, limits, concurrency)` does a BFS
from the root transaction:

1. Pop txid from a `VecDeque<(Txid, depth)>`.
2. Skip if visited or if any limit is hit (set `truncated = true`).
3. Fetch via cache-or-RPC (semaphore-gated).
4. Convert `RawTxInfo` → `TxNode`, resolving prevout values/scripts.
5. For each non-coinbase input, enqueue the funding txid at `depth + 1`.
6. Record `AncestryEdge` for each input→funding relationship.

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

### `labels.rs` — BIP-329 labels and label files

Single file containing types and the label store.

**Types:**

- `Bip329Type` — `Tx`, `Addr`, `Pubkey`, `Input`, `Output`, `Xpub`
- `Bip329Record` — type + ref + label + optional origin/spendable
- `LabelFileKind` — `Local` (editable) or `Pack` (read-only)
- `LabelFileMeta` / `LabelFileSummary` — file identity and metadata

**`LabelStore`** holds two ordered in-memory collections:

- local label files (created/imported from the Web UI, editable)
- pack label files (loaded from CLI dirs at startup, read-only)

Labels are resolved in deterministic order: local files first, then
pack files. This allows user-local overrides while keeping pack labels
visible.

Key operations:

- `list_local_files()` — enumerate editable local files
- `create_local_file(name)` — create empty local file
- `import_local_file(name, content)` — create and import JSONL
- `replace_local_file_content(file_id, content)` — replace full file
- `set_local_label(file_id, type, ref, label)` — upsert in target file
- `export_local_file(file_id)` — export one local file as JSONL
- `remove_local_file(file_id)` — drop local file from memory
- `load_pack_dir(path)` — recursively load read-only `.jsonl` pack files
- `get_all_labels_for_ref(ref)` — all matching labels with source metadata

The caller (`cory` server) wraps the store in `Arc<RwLock<LabelStore>>` for
concurrent access.

### `error.rs` — Error types

`CoreError` with `thiserror`: `Rpc`, `TxNotFound`, `InvalidTxData`,
`LabelParse`, `Io`.

## cory (CLI + server)

### `cli.rs` — Command-line arguments

Clap derive struct. Notable options:

- `--rpc-url`, `--rpc-user`, `--rpc-pass` (user/pass also via env vars)
- `--label-pack-dir` — repeatable, loads read-only label packs
- `--max-depth`, `--max-nodes`, `--max-edges` — graph limits
- `--rpc-concurrency` — semaphore permits for parallel RPC calls

### `main.rs` — Startup

1. Parse CLI, init tracing.
2. Generate random 32-char hex API token.
3. Connect to Bitcoin Core RPC. **This is fatal** — if
   `get_blockchain_info()` fails, the process exits with an error.
4. Create cache and label store.
5. Load label pack directories.
6. Build Axum router and start server.

### `server.rs` — HTTP API

**Routes:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/health` | No | `{"status": "ok"}` |
| GET | `/api/v1/graph/tx/{txid}` | No | Build ancestry graph |
| GET | `/api/v1/label` | No | List local label files |
| POST | `/api/v1/label` | Yes | Create file or import JSONL |
| POST | `/api/v1/label/{file_id}` | Yes | Upsert label or replace file content |
| DELETE | `/api/v1/label/{file_id}/entry?type=tx&ref=<txid>` | Yes | Delete one label entry from a local file |
| DELETE | `/api/v1/label/{file_id}` | Yes | Remove local label file |
| GET | `/api/v1/label/{file_id}/export` | No | Export one local file |
| GET | `*` (fallback) | No | Serve embedded UI |

Auth is via `X-API-Token` header, checked only on mutating endpoints.
CORS is locked to the exact server origin.

The graph response includes the raw `AncestryGraph` (flattened), plus
per-node `enrichments` (fee, feerate, RBF, locktime) and `labels`.

Local label files are in-memory only for the server process lifetime.
The browser owns disk I/O: import reads local files and sends content to
the server; export downloads server-provided JSONL.

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
    Header.tsx             Brand + search bar + API token input
    GraphPanel.tsx         React Flow wrapper (nodes, edges, controls, minimap)
    TxNode.tsx             Custom node (txid, fee/feerate meta, inline label editors)
    LabelPanel.tsx         Right sidebar: local label file manager
```

**Features:**

- Txid search → interactive DAG visualization with ELK layered layout
- Click a node to select it → label panel shows details
- Create/import/remove local label files (POST/DELETE with API token)
- Edit node labels inline with autosave (2s debounce) in a specific local file
- Delete one node label from a local file (DELETE entry endpoint)
- Export per-file BIP-329 JSONL
- Drag nodes, zoom, pan, minimap, fit-to-view controls

**Build integration:**

- `crates/cory/build.rs` runs `npm install && npm run build` during
  `cargo build`, with `[ui]`-prefixed status logging.
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
  `schema_version`, `run_id`, `server_url`, `api_token`, and scenario records
  (`name`, `description`, `root_txid`, `related_txids`, `suggested_ui_checks`).

Graph scenarios are split into two tiers:

- Functional coverage: small chain, merge/dedup behavior, wide frontier,
  depth/node/edge truncation, and spent-prevout resolution gaps.
- Stress coverage: deep, wide, and merge-heavy graphs with large
  topologies (default target is 500 transactions per stress scenario).
- Server coverage: all `server.rs` routes including auth failures,
  local label file CRUD, per-entry label delete, static fallback, and
  exact-origin CORS.

Because Bitcoin UTXO ancestry is acyclic by construction, the stress
suite uses dense merge and frontier patterns rather than true cycle
fixtures.

## Known quirks and things that may need fixing

### `TxNode.block_height` is always None

Bitcoin Core's `getrawtransaction` (verbosity=1) does not include block
height. We'd need a separate `getblockheader` call on the block hash to
populate it. This means `TxNode::confirmations()` always returns `None`.

### Graph BFS is still sequential per node

Traversal remains sequential at the node-processing level. We do batch
`gettxout` requests for unresolved prevouts within a node, but we still
do not process multiple BFS frontier nodes concurrently. Spawning tasks
(e.g. via `JoinSet`) per level would improve wide-graph latency.

### Prevout resolution gaps

If a funding transaction is beyond the graph limits (not fetched), and
the output is already spent (so `gettxout` returns nothing), the input's
value and script type remain `None`. This is unavoidable without
fetching the funding tx, but it means fee calculation returns `None` for
the spending transaction.

### Local labels are ephemeral

Server-local label files are in-memory only and are dropped when the
process exits. Durable persistence is intentionally delegated to manual
UI export/import workflows.

### No `txindex` detection

The CLI does not check whether the node has `txindex=1`. Without it,
`getrawtransaction` fails for transactions not in the mempool unless a
block hash is provided. The user gets an opaque RPC error.

### `ScriptType` doesn't cover multisig or bare scripts

Scripts that aren't one of the standard types (p2pkh, p2sh, p2wpkh,
p2wsh, p2tr, op_return) are classified as `Unknown`. This includes bare
multisig and non-standard scripts.

### No cache eviction

The in-memory caches grow without bound. For long-running sessions
exploring many transactions, this could consume significant memory.
There is no LRU eviction or size limit.

### `version` field compatibility

Bitcoin Core returns version as a signed integer. The HTTP adapter parses
it as `i32` directly so negative versions are preserved.
