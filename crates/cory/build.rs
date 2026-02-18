// ==============================================================================
// UI Build Script
// ==============================================================================
//
// Automatically builds the React UI during `cargo build` so the embedded
// SPA is always up-to-date when npm is available. If npm is unavailable
// or a build step fails, we continue compiling the server and rely on
// existing embedded assets (if any).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha512};

/// All build-script output goes through `cargo:warning=` because that's the
/// only channel Cargo shows to the user. We prefix each line with `[ui]` so
/// our messages are easy to spot among other build output.
macro_rules! log {
    ($($arg:tt)*) => {
        println!("cargo:warning=[ui] {}", format!($($arg)*))
    };
}

/// Config files whose changes should trigger a UI rebuild.
const UI_CONFIG_FILES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
];

fn main() {
    let ui_dir = Path::new("ui");
    let has_npm_project =
        ui_dir.join("package.json").exists() && ui_dir.join("package-lock.json").exists();

    // Tell Cargo when to re-run this script: only when UI source files
    // or config change. This avoids re-running npm on every Rust-only build.
    let watched = emit_rerun_directives(ui_dir);
    log!("watching {watched} UI source files for changes");

    // Ensure ui/dist/ exists so rust-embed's #[folder] compiles even
    // when npm is unavailable or the build is skipped.
    let dist = ui_dir.join("dist");
    std::fs::create_dir_all(&dist).expect("create ui/dist directory");

    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "unknown".to_string());

    // Packaged crates include prebuilt `ui/dist` but not necessarily npm project
    // files. If the npm project files are absent, skip npm steps entirely.
    if !has_npm_project {
        let hash = compute_dist_hash(&dist);
        log_ui_warning(&[
            "Using PRE-COMPILED and PRE-BUILT UI.",
            &format!("cory package version: {}", version),
            "",
            "If you are concerned with supply chain attacks, build UI from source with npm.",
            "",
            "Verify the UI integrity with the official release:",
            &format!(
                "https://github.com/panon-btc/cory/releases/tag/v{}",
                version
            ),
            "",
            &format!("Pre-built UI SHA-512 for cory v{}: {}", version, hash),
        ]);
        return;
    }

    // Skip the npm build if UI source files haven't changed since the last
    // successful build. We hash all watched files and compare against a
    // cached marker in target/.
    let hash_marker =
        Path::new(&std::env::var("OUT_DIR").unwrap_or_default()).join("ui-build-hash");
    let current_hash = hash_ui_sources(ui_dir);

    let mut needs_build = true;
    if dist.join("index.html").exists() {
        if let Ok(cached) = std::fs::read_to_string(&hash_marker) {
            if cached.trim() == current_hash {
                log!("UI sources unchanged: skipping npm build");
                needs_build = false;
            }
        }
    }

    if needs_build {
        // Check if npm is available at all.
        let npm_version = Command::new("npm").arg("--version").output();

        match &npm_version {
            Ok(o) if o.status.success() => {
                let ver = String::from_utf8_lossy(&o.stdout);
                log!("npm found: v{}", ver.trim());
            }
            _ => {
                log!("npm not found — skipping UI build");
                log_ui_warning(&[
                    "The server will compile, but the UI will show:",
                    "  \"Cory was built without UI (no NPM at build time)\"",
                    "",
                    "Install Node.js + npm and rebuild to get the UI.",
                ]);
                return;
            }
        }

        // --- npm ci (deterministic install) ------------------------------------
        log!("running `npm ci`...");
        if !run_npm_step(&["ci"], ui_dir) {
            return;
        }
        log!("`npm ci` done");

        // --- npm run build ------------------------------------------------------
        log!("running `npm run build`...");
        if !run_npm_step(&["run", "build"], ui_dir) {
            return;
        }
        log!("`npm run build` done, UI assets ready in ui/dist/");

        // Write the hash marker so subsequent builds can skip npm.
        let _ = std::fs::write(&hash_marker, &current_hash);
    }

    // Always compute and print the final SHA-512 of the resulting dist/ folder.
    let hash = compute_dist_hash(&dist);
    log!("Pre-built UI SHA-512 for cory v{}: {}", version, hash);
}

/// Runs an npm command in `ui_dir`. Returns `true` on success, `false` on
/// failure.
fn run_npm_step(args: &[&str], ui_dir: &Path) -> bool {
    let label = format!("npm {}", args.join(" "));

    match Command::new("npm").args(args).current_dir(ui_dir).status() {
        Ok(s) if s.success() => true,
        Ok(s) => {
            log_ui_warning(&[
                &format!("`{label}` failed (exit code: {s})"),
                "",
                "UI will not be embedded. Check the build output above.",
            ]);
            false
        }
        Err(e) => {
            log_ui_warning(&[&format!("`{label}` could not be executed: {e}")]);
            false
        }
    }
}

/// Prints a warning block with a bulleted style.
fn log_ui_warning(lines: &[&str]) {
    log!("----------------------------------------------------------");
    for line in lines {
        if line.is_empty() {
            log!("");
        } else {
            log!("  > {}", line);
        }
    }
    log!("----------------------------------------------------------");
}

// ==============================================================================
// Cargo rerun-if-changed directives
// ==============================================================================

/// Emits `cargo:rerun-if-changed` for all UI config and source files.
/// Returns the total number of watched paths.
fn emit_rerun_directives(ui_dir: &Path) -> usize {
    let mut count = 0;

    for name in UI_CONFIG_FILES {
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

    for name in UI_CONFIG_FILES {
        let path = ui_dir.join(name);
        if let Ok(meta) = std::fs::metadata(&path) {
            path.display().to_string().hash(&mut hasher);
            if let Ok(modified) = meta.modified() {
                modified.hash(&mut hasher);
            }
            meta.len().hash(&mut hasher);
        }
    }

    // Hash all source and public files.
    for dir_name in &["src", "public"] {
        let dir = ui_dir.join(dir_name);
        if dir.exists() {
            for path in collect_files(&dir) {
                if let Ok(meta) = std::fs::metadata(&path) {
                    path.display().to_string().hash(&mut hasher);
                    if let Ok(modified) = meta.modified() {
                        modified.hash(&mut hasher);
                    }
                    meta.len().hash(&mut hasher);
                }
            }
        }
    }

    format!("{:016x}", hasher.finish())
}

/// Recursively collects all files in a directory, sorted by path.
fn collect_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_recursive(dir, &mut files);
    files.sort();
    files
}

fn collect_recursive(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_recursive(&path, files);
            } else {
                files.push(path);
            }
        }
    }
}

/// Compute a deterministic SHA-512 hash of all files in a directory.
fn compute_dist_hash(dist_dir: &Path) -> String {
    let mut hasher = Sha512::new();

    for path in collect_files(dist_dir) {
        // Hash the relative path to distinguish files with same content but different names.
        if let Ok(relative) = path.strip_prefix(dist_dir) {
            hasher.update(relative.to_string_lossy().as_bytes());
        }

        // Hash the file content.
        if let Ok(content) = std::fs::read(&path) {
            hasher.update(&content);
        }
    }

    hex::encode(hasher.finalize())
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
