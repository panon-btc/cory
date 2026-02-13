<p align="center">
  <img src="logo.png" alt="Cory logo" width="220" />
</p>

<p align="center">Local-first Bitcoin transaction ancestry explorer and BIP-329 label editor.</p>

## What This Is

This project aims to be a privacy-preserving tool that:
- Connects to a local Bitcoin Core node over RPC.
- Builds a transaction spending ancestry graph (DAG with merges) starting from a user-provided `txid`.
- Lets you create/import/export in-memory local label files in BIP-329 (JSONL) from the Web UI.
- Lets you load additional read-only "label packs" (e.g. exchanges, hacks) from folders and apply them as annotations in the graph.

## Requirements

- Rust toolchain (stable)
- A local Bitcoin Core node with RPC enabled (`txindex=1`)

## Quick Start

Run directly from source:
- `cargo run --bin cory -- --rpc-url http://127.0.0.1:8332 --rpc-user <user> --rpc-pass <pass>`

Install a local binary and run by command name:
- `cargo install --path crates/cory`
- `cory --rpc-url http://127.0.0.1:8332 --rpc-user <user> --rpc-pass <pass>`

## Privacy Model

- Designed to run fully offline against your own node.
- The local web server binds to `127.0.0.1` by default.
- The UI serves local static assets only (no CDNs).
- Mutating API calls require JWT cookie authentication to reduce localhost CSRF risk.
  A session token is automatically acquired by the UI on page load.


## Labels

- Import/export format: BIP-329 JSONL.
- Local label files: editable and in-memory for the current server process.
  Import/export is browser-managed (import reads from disk in browser, export downloads JSONL from server).
- Pack label files: read-only, loaded from CLI `--label-pack-dir` folders.

Label resolution order:
1. Local files
2. Pack files

If multiple labels apply, the UI displays all matches.

A label pack is a folder containing one or more read-only BIP-329 JSONL files.

Example:
- `labels/exchanges/binance.jsonl`
- `labels/hacks/example_hack.jsonl`

Each file becomes a namespace, derived from the relative path (e.g. `pack:exchanges/binance`).

## Repo Layout

Rust workspace:
- `crates/cory-core` (library)
  - RPC client wrapper (behind a mockable trait)
  - Graph builder (ancestry DAG)
  - Label store (BIP-329 import/export, namespaces)
  - Caching layer (in-memory; optional disk cache opt-in)
  - Enrichments (script types, locktime/RBF flags, fee/feerate)
- `crates/cory` (binary)
  - CLI flags/config
  - Axum server, JSON API, static UI serving

UI:
- React + React Flow SPA under `crates/cory/ui/` (built automatically by `build.rs` and embedded into the binary via `rust-embed`)

## Optional Enrichments

Recommended deterministic enrichments:
- script types for inputs/outputs (P2WPKH/P2TR/etc)
- locktime and RBF signaling flags
- fee and feerate (requires prevout values)

Optional heuristics (must be opt-in and clearly labeled as uncertain):
- coinjoin detection warnings
- likely-change hints

## Development

### Requirements

- Rust toolchain (stable)
- Node.js + npm (for the UI; optional — the server compiles without it)
- Python 3 (for regtest/UI test scripts)
- `bitcoind` + `bitcoin-cli` in PATH (for regtest and UI tests)

### Make targets

| Command | Description |
|---------|-------------|
| `make build` | Build everything — UI is compiled automatically via `build.rs` |
| `make test` | Run unit tests across all crates |
| `make fmt` | Format all code (Rust + UI) |
| `make regtest` | Run regtest e2e scripts (requires `bitcoind` in PATH) |
| `make uireg` | Run manual UI fixture workflow (requires `bitcoind` in PATH) |
| `make playwright` | Run Playwright E2E tests (requires `playwright` + Chromium) |
| `make ui` | Start Vite dev server with HMR on `:5173` (for UI development) |
| `make run` | Start the Cory server on `:3080` |
| `make clean` | Remove all build artifacts (Rust `target/` + UI `node_modules/` and `dist/`) |

### UI development workflow

For fast UI iteration with hot-module reloading:

1. **Terminal 1** — start the Rust server: `make run` (or `cargo run -- [flags]`)
2. **Terminal 2** — start the Vite dev server: `make ui`
3. Open `http://localhost:5173` — Vite proxies `/api` to the Rust server

Edit any React file under `crates/cory/ui/src/` for instant hot reload.
No Rust recompile needed for UI changes.

### Linting

- `cargo fmt --all`
- `cargo clippy --all-targets --all-features -- -D warnings`

### Regtest scripts

- `python3 scripts/regtest/rpc_e2e.py` — native RPC runner
- `python3 scripts/regtest/graph.py` — graph runner (functional + stress scenarios)
- `python3 scripts/regtest/server_e2e.py` — server API runner (full endpoint coverage)
- `python3 scripts/ui/manual_fixtures.py` — manual UI fixture workflow (starts live server + prints exploration guide)

The script starts a temporary regtest node in `tmp/regtest-it-<timestamp>-<pid>/`, mines
funding blocks, creates sample transactions, and runs
`crates/cory-core/tests/regtest_rpc.rs` against the live RPC endpoint.
It also enables verbose test output (`--nocapture`) and sets
`RUST_LOG=cory_core=trace` by default so RPC traces are visible.

The graph runner writes a deterministic scenario fixture to
`tmp/regtest_graph_fixture-<timestamp>-<pid>.json` and executes
`crates/cory-core/tests/regtest_graph.rs`. By default it runs both tiers:
functional edge cases and stress scenarios (including ~500 tx topologies).
Use `GRAPH_SCENARIO_TIER=functional|stress|all` and
`GRAPH_STRESS_TX_TARGET=<n>` to tune runtime.

The server runner provisions a regtest fixture transaction, starts a live
`cory` process bound to localhost, writes a server fixture to
`tmp/regtest_server_fixture-<timestamp>-<pid>.json`, and executes
`crates/cory/tests/regtest_server.rs` to validate every HTTP endpoint
(health, graph, label file CRUD, per-file export, per-entry upsert/delete auth paths,
static fallback, and CORS).

The manual UI fixture runner generates in-the-wild-like ancestry patterns
(chains, merges, fan-in/out, RBF replacement, OP_RETURN, and truncation-depth
cases), starts a live localhost `cory` process, and writes a machine-readable
catalog to `tmp/ui_manual_fixture-<timestamp>-<pid>.json` for reproducible
exploration sessions. Use `--no-hold` for setup-only mode.

Architecture details:
- `docs/ARCHITECTURE.md`

## License

Licensed under the MIT License. See `LICENSE`.
