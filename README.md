<p align="center">
  <img src="logo.svg" alt="Cory logo" width="360" />
</p>

<p align="center">
Local-first Bitcoin transaction ancestry explorer and BIP-329 label editor.
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
- Node.js + npm (required when building from source)

For reliable historical lookups, run Bitcoin Core with `txindex=1`.

### Run From Source

```bash
cargo run --bin cory -- \
  --connection http://127.0.0.1:8332 \
  --rpc-user <user> \
  --rpc-pass <pass>
```

Then open:

```text
http://127.0.0.1:3080
```

On startup, Cory prints:
- a session API token
- a safe URL (no token in query string)
- an optional bootstrap URL with `?token=...` and a leak warning

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
