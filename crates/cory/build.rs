// ==============================================================================
// UI Build Script
// ==============================================================================
//
// Automatically builds the React UI during `cargo build` so the embedded
// SPA is always up-to-date. If npm/Node.js is not installed, the build
// still succeeds — the server will show a clear "UI not built" message
// at runtime instead.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;

/// All build-script output goes through `cargo:warning=` because that's the
/// only channel Cargo shows to the user. We prefix each line with `[ui]` so
/// our messages are easy to spot among other build output.
macro_rules! log {
    ($($arg:tt)*) => {
        println!("cargo:warning=[ui] {}", format!($($arg)*))
    };
}

fn main() {
    // When CORY_REQUIRE_UI=1 (set in CI), npm/vite failures abort the build
    // instead of falling back to the "UI not built" runtime message.
    let require_ui = std::env::var("CORY_REQUIRE_UI").unwrap_or_default() == "1";
    println!("cargo:rerun-if-env-changed=CORY_REQUIRE_UI");

    let ui_dir = Path::new("ui");

    // Tell Cargo when to re-run this script: only when UI source files
    // or config change. This avoids re-running npm on every Rust-only build.
    let watched = emit_rerun_directives(ui_dir);
    log!("watching {watched} UI source files for changes");

    // Ensure ui/dist/ exists so rust-embed's #[folder] compiles even
    // when npm is unavailable or the build is skipped.
    let dist = ui_dir.join("dist");
    std::fs::create_dir_all(&dist).expect("create ui/dist directory");

    // Skip the npm build if UI source files haven't changed since the last
    // successful build. We hash all watched files and compare against a
    // cached marker in target/.
    let hash_marker =
        Path::new(&std::env::var("OUT_DIR").unwrap_or_default()).join("ui-build-hash");
    let current_hash = hash_ui_sources(ui_dir);
    if dist.join("index.html").exists() {
        if let Ok(cached) = std::fs::read_to_string(&hash_marker) {
            if cached.trim() == current_hash {
                log!("UI sources unchanged — skipping npm build");
                return;
            }
        }
    }

    // Check if npm is available at all.
    let npm_version = Command::new("npm").arg("--version").output();

    match &npm_version {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout);
            log!("npm found: v{}", ver.trim());
        }
        _ => {
            log!("npm not found — skipping UI build");
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  The server will compile, but the UI will show:     ║");
            log!("║    \"UI not built. Run: cd ui && npm run build\"       ║");
            log!("║                                                     ║");
            log!("║  Install Node.js + npm and rebuild to get the UI.   ║");
            log!("╚══════════════════════════════════════════════════════╝");
            if require_ui {
                std::process::exit(1);
            }
            return;
        }
    }

    // --- npm ci (deterministic install) ------------------------------------
    //
    // Use `npm ci` instead of `npm install` for reproducible builds: it
    // installs from the lockfile exactly, never modifying package-lock.json.

    log!("running `npm ci`...");

    let install = Command::new("npm").arg("ci").current_dir(ui_dir).status();

    match install {
        Ok(s) if s.success() => {
            log!("`npm ci` done");
        }
        Ok(s) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  `npm ci` failed (exit code: {:<22}║", format!("{s})"));
            log!("║                                                     ║");
            log!("║  UI will not be embedded. Check ui/package.json     ║");
            log!("║  and your Node.js installation.                     ║");
            log!("╚══════════════════════════════════════════════════════╝");
            if require_ui {
                std::process::exit(1);
            }
            return;
        }
        Err(e) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  `npm ci` could not be executed:                    ║");
            log!("║  {:<52}║", e);
            log!("╚══════════════════════════════════════════════════════╝");
            if require_ui {
                std::process::exit(1);
            }
            return;
        }
    }

    // --- npm run build ------------------------------------------------------

    log!("running `npm run build`...");

    let build = Command::new("npm")
        .args(["run", "build"])
        .current_dir(ui_dir)
        .status();

    match build {
        Ok(s) if s.success() => {
            log!("`npm run build` done — UI assets ready in ui/dist/");
            // Write the hash marker so subsequent builds can skip npm.
            let _ = std::fs::write(&hash_marker, &current_hash);
        }
        Ok(s) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!(
                "║  `npm run build` failed (exit code: {:<15}║",
                format!("{s})")
            );
            log!("║                                                     ║");
            log!("║  UI will not be embedded. Check the TypeScript and  ║");
            log!("║  Vite output above for errors.                      ║");
            log!("╚══════════════════════════════════════════════════════╝");
            if require_ui {
                std::process::exit(1);
            }
        }
        Err(e) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  `npm run build` could not be executed:             ║");
            log!("║  {:<52}║", e);
            log!("╚══════════════════════════════════════════════════════╝");
            if require_ui {
                std::process::exit(1);
            }
        }
    }
}

// ==============================================================================
// Cargo rerun-if-changed directives
// ==============================================================================

/// Emits `cargo:rerun-if-changed` for all UI config and source files.
/// Returns the total number of watched paths.
fn emit_rerun_directives(ui_dir: &Path) -> usize {
    let mut count = 0;

    // Config files — any change here should trigger a rebuild.
    for name in [
        "package.json",
        "package-lock.json",
        "index.html",
        "vite.config.ts",
        "tsconfig.json",
        "tsconfig.app.json",
        "tsconfig.node.json",
    ] {
        println!("cargo:rerun-if-changed=ui/{name}");
        count += 1;
    }

    // All source files under ui/src/.
    let src = ui_dir.join("src");
    if src.exists() {
        count += walk_rerun(&src);
    }

    // Static files served as-is by Vite from ui/public/.
    let public = ui_dir.join("public");
    if public.exists() {
        count += walk_rerun(&public);
    }

    count
}

/// Compute a hash of all UI source and config files for change detection.
/// Uses file modification times rather than content for speed.
fn hash_ui_sources(ui_dir: &Path) -> String {
    let mut hasher = DefaultHasher::new();

    // Hash config files.
    for name in [
        "package.json",
        "package-lock.json",
        "index.html",
        "vite.config.ts",
        "tsconfig.json",
        "tsconfig.app.json",
        "tsconfig.node.json",
    ] {
        let path = ui_dir.join(name);
        if let Ok(meta) = std::fs::metadata(&path) {
            path.display().to_string().hash(&mut hasher);
            if let Ok(modified) = meta.modified() {
                modified.hash(&mut hasher);
            }
            meta.len().hash(&mut hasher);
        }
    }

    // Hash all source files under ui/src/.
    let src = ui_dir.join("src");
    if src.exists() {
        hash_dir(&src, &mut hasher);
    }

    // Hash static public files so changing images invalidates the UI cache key.
    let public = ui_dir.join("public");
    if public.exists() {
        hash_dir(&public, &mut hasher);
    }

    format!("{:016x}", hasher.finish())
}

fn hash_dir(dir: &Path, hasher: &mut DefaultHasher) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();

    for path in paths {
        if path.is_dir() {
            hash_dir(&path, hasher);
        } else if let Ok(meta) = std::fs::metadata(&path) {
            path.display().to_string().hash(hasher);
            if let Ok(modified) = meta.modified() {
                modified.hash(hasher);
            }
            meta.len().hash(hasher);
        }
    }
}

/// Recursively emits `cargo:rerun-if-changed` for every file and directory
/// under `dir`. Returns the number of paths emitted.
fn walk_rerun(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0;

    // Watch the directory itself so new file creation triggers a rebuild.
    println!("cargo:rerun-if-changed={}", dir.display());
    count += 1;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            count += walk_rerun(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
            count += 1;
        }
    }

    count
}
