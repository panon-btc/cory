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

## 1. Bump versions (before build/publish)

Update these fields together:

- `crates/cory-core/Cargo.toml`:
  - `[package].version`
- `crates/cory/Cargo.toml`:
  - `[package].version`
  - `[dependencies].cory-core.version`

Then verify:

```bash
rg -n '^version = ' crates/cory-core/Cargo.toml crates/cory/Cargo.toml
rg -n '^cory-core = ' crates/cory/Cargo.toml
```

## 2. Build UI assets (for `cory` crate packaging)

```bash
(cd crates/cory/ui && npm ci && npm run build)
```

## 3. Run quality gates

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
cargo build --release --bin cory
```

## 4. Verify package contents

```bash
mkdir -p tmp
cargo package -p cory-core --allow-dirty --list > tmp/cory-core-package-files.txt
cargo package -p cory --allow-dirty --list > tmp/cory-package-files.txt
rg -n '^README.md$' tmp/cory-core-package-files.txt
rg -n '^README.md$' tmp/cory-package-files.txt
rg -n '^ui/dist/index.html$' tmp/cory-package-files.txt
```
## 5. Commit release version bumps (before tag)

Create a commit that contains at least the version bump changes.
Do this before `cargo publish`; otherwise publish may fail on a dirty
working tree (especially `cory-core`, which is published without
`--allow-dirty`).

Example:

```bash
git add crates/cory-core/Cargo.toml crates/cory/Cargo.toml
git commit -m "chore(release): bump crates to vX.Y.Z"
```

## 6. Dry-run publish

```bash
cargo publish -p cory-core --dry-run
cargo publish -p cory --dry-run --allow-dirty
```

`cory` uses `--allow-dirty` in this workflow because `crates/cory/ui/dist`
is generated and often left untracked/ignored locally.


## 7. Tag release commit (immediately after commit)

Tag the release commit (the one that bumped versions) right after
committing.

```bash
git tag -a vX.Y.Z -m "release: vX.Y.Z"
git push origin vX.Y.Z
```

## 8. Publish (order matters)

```bash
cargo publish -p cory-core
```

Wait for crates.io index propagation, then:

```bash
cargo publish -p cory --allow-dirty
```

`--allow-dirty` here is only to tolerate generated UI artifacts in
`crates/cory/ui/dist`. Prefer keeping all tracked release changes
committed before publishing.

## 9. Post-publish verification

```bash
cargo install cory --locked
cory --help
```

Also verify:

- https://crates.io/crates/cory-core
- https://crates.io/crates/cory
- https://docs.rs/cory-core
- https://docs.rs/cory

## 10. GitHub release

Create a GitHub Release for the tag with:

- summary of user-visible changes
- crates.io links
- install command: `cargo install cory`
