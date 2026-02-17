# Releasing Cory

This document captures the exact command flow used for crates.io releases.

## Prerequisites

- `cargo login` already configured for crates.io
- Node.js + npm installed (for generating `crates/cory/ui/dist`)
- Clean git state for source changes (except generated `ui/dist` if you keep it untracked)

## 0. Check current state

```bash
git status --short
```

## 1. Build UI assets (for `cory` crate packaging)

```bash
(cd crates/cory/ui && npm ci && npm run build)
```

## 2. Run quality gates

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
cargo build --release --bin cory
```

## 3. Verify package contents

```bash
mkdir -p tmp
cargo package -p cory-core --allow-dirty --list > tmp/cory-core-package-files.txt
cargo package -p cory --allow-dirty --list > tmp/cory-package-files.txt
rg -n '^README.md$' tmp/cory-core-package-files.txt
rg -n '^README.md$' tmp/cory-package-files.txt
rg -n '^ui/dist/index.html$' tmp/cory-package-files.txt
```

## 4. Dry-run publish

```bash
cargo publish -p cory-core --dry-run
cargo publish -p cory --dry-run --allow-dirty
```

`cory` uses `--allow-dirty` in this workflow because `crates/cory/ui/dist`
is generated and often left untracked/ignored locally.

## 5. Publish (order matters)

```bash
cargo publish -p cory-core
```

Wait for crates.io index propagation, then:

```bash
cargo publish -p cory --allow-dirty
```

## 6. Post-publish verification

```bash
cargo install cory --locked
cory --help
```

Also verify:

- https://crates.io/crates/cory-core
- https://crates.io/crates/cory
- https://docs.rs/cory-core
- https://docs.rs/cory

## 7. GitHub release

```bash
git tag -a v0.1.0 -m "release: v0.1.0"
git push origin v0.1.0
```

Then create a GitHub Release for the tag with:

- summary of user-visible changes
- crates.io links
- install command: `cargo install cory`
