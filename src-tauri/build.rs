fn main() {
    println!("cargo:rerun-if-env-changed=KUROCAT_YY_THUNKS_OBJ");
    println!("cargo:rerun-if-env-changed=KUROCAT_VC_LTL_LIB");
    println!("cargo:rerun-if-env-changed=KUROCAT_WIN7_OLE32_SHIM_OBJ");
    // A diagnostics log from another machine is only useful when it says which
    // build produced it, so the commit id is baked into the binary.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads/main");
    println!("cargo:rerun-if-changed=../.git/index");
    println!("cargo:rustc-env=KUROCAT_BUILD_ID={}", build_id());
    #[cfg(feature = "win7")]
    {
        if let Ok(vc_ltl) = std::env::var("KUROCAT_VC_LTL_LIB") {
            let trimmed = vc_ltl.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-search=native={}", trimmed);
            }
        }
        if let Ok(shim) = std::env::var("KUROCAT_WIN7_OLE32_SHIM_OBJ") {
            let trimmed = shim.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-arg-bin=KuroCat={}", trimmed);
            }
        }
        if let Ok(obj) = std::env::var("KUROCAT_YY_THUNKS_OBJ") {
            let trimmed = obj.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-arg-bin=KuroCat={}", trimmed);
                println!("cargo:rustc-link-arg-bin=KuroCat=/SUBSYSTEM:WINDOWS,6.01");
            }
        }
    }
    tauri_build::build();

    // A release build without the custom protocol produces a binary that
    // loads the Vite dev server (http://localhost:1420) instead of the
    // embedded frontend, so the installed app only shows "localhost refused
    // to connect". The Tauri CLI enables `tauri/custom-protocol` for
    // `tauri build`; a hand rolled `cargo build --release` does not.
    // Fail loudly instead of shipping a broken installer.
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" && tauri_build::is_dev() {
        panic!(
            "release build without `tauri/custom-protocol`: the binary would load \
             http://localhost:1420 instead of the embedded frontend. Use \
             `npm run tauri -- build --bundles nsis`, or \
             `cargo build --release --features custom-protocol`."
        );
    }
}

/// Short commit id of the source tree, plus a dirty marker when the working
/// tree differs from it. Used to tell logs from different builds apart.
fn build_id() -> String {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .ok()
    };
    let commit = git(&["rev-parse", "--short=12", "HEAD"])
        .filter(|result| result.status.success())
        .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "nogit".to_string());
    // PROJECT_STATUS.md is a local working copy that is never committed,
    // so it must not make every build look dirty.
    let dirty = git(&[
        "status",
        "--porcelain",
        "--untracked-files=no",
        "--",
        ".",
        ":(exclude)PROJECT_STATUS.md",
    ])
    .map(|result| !result.stdout.is_empty())
    .unwrap_or(false);
    if dirty {
        format!("{commit}-dirty")
    } else {
        commit
    }
}
