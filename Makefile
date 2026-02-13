.PHONY: build test fmt regtest uireg playwright ui run clean

# Build everything (UI is built automatically via build.rs).
build:
	cargo build --workspace --all-targets

# Run unit tests.
test:
	cargo test --workspace --all-targets

# Format all code (Rust + UI).
fmt:
	cargo fmt --all
	cd crates/cory/ui && npm run fmt

# Run regtest end-to-end scripts (requires bitcoind + bitcoin-cli in PATH).
regtest:
	python3 scripts/regtest/rpc_e2e.py
	python3 scripts/regtest/graph.py
	python3 scripts/regtest/server_e2e.py

# Run manual UI fixture workflow (requires bitcoind + bitcoin-cli in PATH).
uireg:
	python3 scripts/ui/manual_fixtures.py

# Run Playwright E2E tests (requires playwright + chromium).
playwright:
	python3 scripts/ui/playwright/label.py

# Start the Vite dev server with HMR (run the Rust server separately).
ui:
	cd crates/cory/ui && npm install && npm run dev

# Run the Cory server (builds UI automatically).
run:
	cargo run

# Remove all build artifacts (Rust + UI).
clean:
	cargo clean
	cd crates/cory/ui && npm run clean
