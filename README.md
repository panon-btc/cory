<p align="center">
  <img src="logo.svg" alt="Cory logo" width="360" />
</p>

<p align="center">
Local-first Bitcoin transaction ancestry explorer and BIP-329 label editor.
</p>

<p align="center">
  <a href="https://github.com/panon-btc/cory/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/panon-btc/cory/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://crates.io/crates/cory"><img alt="Crates.io (cory)" src="https://img.shields.io/crates/v/cory.svg"></a>
  <a href="https://docs.rs/cory-core"><img alt="docs.rs (cory-core)" src="https://img.shields.io/docsrs/cory-core"></a>
  <a href="https://github.com/panon-btc/cory/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/panon-btc/cory"></a>
  <a href="https://github.com/panon-btc/cory/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/panon-btc/cory"></a>
  <a href="https://github.com/panon-btc/cory/commits"><img alt="Last commit" src="https://img.shields.io/github/last-commit/panon-btc/cory"></a>
  <a href="https://github.com/panon-btc/cory/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/panon-btc/cory"></a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/0338f1f3-111d-41ef-9769-6c4e46c9e298" alt="Cory screenshot" controls></video>
</p>


Cory helps you inspect where a Bitcoin transaction's funds came from,
interactively, on your own machine.

- Local-first: runs against your own Bitcoin Core node.
- Private by default: localhost server, no CDN dependencies.
- Analyst-friendly graph view: ancestry DAG with script/fee/RBF/locktime context.
- Practical labeling: BIP-329 import/export and in-app editing.

## Features

- Build ancestry graphs from any txid, with configurable depth/node/edge limits.
- Resolve and display labels for:
  - `tx`
  - `input`
  - `output`
  - derived `addr`
- Manage label files in the UI:
  - create/import/export/delete browser files
  - export all browser files as a ZIP
- Load persistent label directories:
  - `--labels-rw` (editable, auto-flushed to disk)
  - `--labels-ro` (read-only)
- Search history endpoint and UI panel for recent lookups.

## Quick Start

### Requirements

- Rust (stable)
- Bitcoin Core RPC endpoint

### Install

```bash
cargo install cory
```

### Run

```bash
cory \
  --connection http://127.0.0.1:8332 \
  --rpc-user <user> \
  --rpc-pass <pass>
```

Open `http://127.0.0.1:3080`.

For reliable historical lookups, run Bitcoin Core with `txindex=1`.

You can also use a public endpoint (and leak your searches) by lowering
connection requirements (see `--help`), e.g.:

```bash
cory --connection https://bitcoin-rpc.publicnode.com --max-depth 2
```

### Some interesting mainnet txids to try

| TXID | Description |
|---|---|
| `591e91f809d716912ca1d4a9295e70c3e78bab077683f79350f101da64588073` | TX ancestors contains the first Satoshi -> Hal Finney transaction |
| `a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d` | bitcoin pizza day (131 inputs: do it with a depth of 1!) |
| `06a0dc290a0f59450a515dd7df3c04d8730a5157c91beba20311f88d0619a670` | `OP_RETURN` "The Great Print - We are all Satoshi" |
| `b10c007c60e14f9d087e0291d4d0c7869697c6681d979c6639dbd960792b4d41` | first [p2tr before activation](https://b10c.me/blog/007-spending-p2tr-pre-activation/) |
| `b10c0000004da5a9d1d9b4ae32e09f0b3e62d21a5cce5428d4ad714fb444eb5d` | [xB10C's weird bitcoin transaction](https://stacker.news/items/593226) |

## Security and Privacy Notes

- Server binds to `127.0.0.1` by default.
- Protected endpoints require `X-API-Token`.
- The UI accepts `?token=` once for bootstrap, then removes it from the URL.
- Token persistence is session-scoped (`sessionStorage`), not `localStorage`.

## Labels

Import/export format: BIP-329 JSONL.

Label file kinds:
1. `PersistentRw`: loaded from `--labels-rw`, editable, auto-flushed to disk.
2. `PersistentRo`: loaded from `--labels-ro`, read-only.
3. `BrowserRw`: created/imported in UI, editable, in-memory.

Resolution order:
1. `PersistentRw`
2. `BrowserRw`
3. `PersistentRo`

## API Summary

Public:
- `GET /api/v1/health`
- `GET /api/v1/limits`

Protected:
- `GET /api/v1/graph/tx/{txid}`
- `GET /api/v1/history`
- `GET/POST /api/v1/label`
- `POST/DELETE /api/v1/label/{file_id}`
- `DELETE /api/v1/label/{file_id}/entry`
- `GET /api/v1/label/{file_id}/export`
- `GET /api/v1/labels.zip`

Behavior notes:
- Unknown API paths return JSON `404`.
- Graph endpoint returns semantic errors (`400`, `404`, `502`, `500`).

## Development

### Development Requirements

- Rust (stable)
- Node.js + npm (required for UI development and source builds)

### Common Commands

| Command | Description |
|---|---|
| `make build` | Build workspace (UI build runs via `build.rs`) |
| `make test` | Run Rust tests |
| `make fmt` | Format Rust + UI code |
| `make run` | Start Cory server |
| `make ui` | Start Vite dev server (`:5173`) |
| `make regtest` | Run regtest integration scripts |
| `make uireg` | Generate manual UI fixture scenarios |
| `make playwright` | Run Playwright UI tests |

### UI Workflow

1. Terminal 1: `make run`
2. Terminal 2: `make ui`
3. Open `http://localhost:5173` (proxies `/api` to Cory on `:3080`)

## Testing

- Fast path: Rust unit/integration tests via `make test`
- Regtest path:
  - `python3 scripts/regtest/rpc_e2e.py`
  - `python3 scripts/regtest/graph.py`
  - `python3 scripts/regtest/server_e2e.py`
- UI/manual and browser E2E:
  - `python3 scripts/ui/manual_fixtures.py`
  - `python3 scripts/ui/playwright/label.py`

## Project Layout

```text
crates/cory-core   # domain logic, graph builder, RPC adapter, labels, cache
crates/cory        # CLI + Axum server + embedded static UI
crates/cory/ui     # React/Vite SPA
scripts/           # regtest and UI automation helpers
docs/              # architecture and contributor docs
```

## Documentation

- Architecture overview: `docs/ARCHITECTURE.md`
- Contributor runtime/style guidance: `AGENTS.md`

## Contributing

Issues and PRs are welcome. Small, focused changes with tests are preferred.
If you are changing API behavior, update docs and add/adjust endpoint tests.

## License

MIT. See `LICENSE`.
