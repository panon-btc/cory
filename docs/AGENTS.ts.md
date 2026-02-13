# TypeScript / React / Vite Guidelines

The UI lives in `crates/cory/ui/` and is a React + React Flow SPA
bundled by Vite and embedded into the Rust binary at compile time.

## Project constraints

- **Fully offline**: no CDN links, no external fonts, no runtime
  fetches to third-party services. Everything must be bundled.
- **Embedded deployment**: Vite's `base: './'` produces relative asset
  paths so the SPA works when served by `rust-embed` from any URL
  prefix.

## TypeScript

- Strict mode is enabled (`strict: true`, `noUncheckedIndexedAccess`).
  Do not weaken these settings.
- Type API responses with interfaces that mirror the Rust server types
  exactly (see `src/types.ts`). Keep them in sync when the Rust API
  changes.
- Prefer `interface` over `type` for object shapes.

## React

- Functional components only. No class components.
- One component per file, named export matching the filename.
- Use `useCallback` and `useMemo` for functions and values passed as
  props to prevent unnecessary re-renders.
- Keep state as high as needed but no higher. `App.tsx` owns
  cross-cutting state (graph, selection, API token); components own
  their local UI state (input values, open/closed).

## Styling

- Use CSS custom properties (defined in `src/index.css`) for all theme
  colors. Do not hardcode color values in components — reference
  `var(--bg)`, `var(--accent)`, etc.
- Inline `style` objects are fine for layout. CSS file for theme
  variables and React Flow overrides.
- The dark theme palette is defined in `:root` in `src/index.css`.
  Match it when adding new UI elements.

## Formatting

- Prettier is the formatter. Run `npm run fmt` before committing.
- CI runs `npm run fmt:check` — unformatted code will fail the build.

## Build and dev

- `npm run build` runs `tsc -b && vite build` (typecheck then bundle).
- `npm run dev` starts the Vite dev server with HMR and proxies `/api`
  to `http://127.0.0.1:3080` (the Rust server).
- The `build.rs` in `crates/cory/` handles `npm install && npm run
  build` automatically during `cargo build`, so manual npm builds are
  only needed for the dev workflow (`make ui`).

## Dependencies

- Keep the dependency footprint small. Currently: React, React Flow,
  ELK.js, and Prettier (dev). Avoid adding large utility libraries
  when a few lines of code suffice.
- Pin major versions in `package.json` (`^19`, `^12`, etc.) to avoid
  surprise breaking changes.

## Graph layout

- ELK.js handles the DAG layout (`src/layout.ts`). Layout options are
  configured for left-to-right layered rendering with orthogonal edge
  routing.
- Sort ELK children by txid for deterministic layout (no jitter between
  re-renders).
- Only include edges where both endpoints exist in the node set (the
  graph may be truncated).
