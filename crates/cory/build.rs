// ==============================================================================
// UI Build Script
// ==============================================================================
//
// Automatically builds the React UI during `cargo build` so the embedded
// SPA is always up-to-date. If npm/Node.js is not installed, the build
// still succeeds — the server will show a clear "UI not built" message
// at runtime instead.

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
    let ui_dir = Path::new("ui");

    // Tell Cargo when to re-run this script: only when UI source files
    // or config change. This avoids re-running npm on every Rust-only build.
    let watched = emit_rerun_directives(ui_dir);
    log!("watching {watched} UI source files for changes");

    // Ensure ui/dist/ exists so rust-embed's #[folder] compiles even
    // when npm is unavailable or the build is skipped.
    let dist = ui_dir.join("dist");
    std::fs::create_dir_all(&dist).expect("create ui/dist directory");

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
            return;
        }
    }

    // --- npm install --------------------------------------------------------

    log!("running `npm install`...");

    let install = Command::new("npm")
        .arg("install")
        .current_dir(ui_dir)
        .status();

    match install {
        Ok(s) if s.success() => {
            log!("`npm install` done");
        }
        Ok(s) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  `npm install` failed (exit code: {:<17}║", format!("{s})"));
            log!("║                                                     ║");
            log!("║  UI will not be embedded. Check ui/package.json     ║");
            log!("║  and your Node.js installation.                     ║");
            log!("╚══════════════════════════════════════════════════════╝");
            return;
        }
        Err(e) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  `npm install` could not be executed:               ║");
            log!("║  {:<52}║", e);
            log!("╚══════════════════════════════════════════════════════╝");
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
        }
        Ok(s) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  `npm run build` failed (exit code: {:<15}║", format!("{s})"));
            log!("║                                                     ║");
            log!("║  UI will not be embedded. Check the TypeScript and  ║");
            log!("║  Vite output above for errors.                      ║");
            log!("╚══════════════════════════════════════════════════════╝");
        }
        Err(e) => {
            log!("╔══════════════════════════════════════════════════════╗");
            log!("║  `npm run build` could not be executed:             ║");
            log!("║  {:<52}║", e);
            log!("╚══════════════════════════════════════════════════════╝");
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

    count
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
