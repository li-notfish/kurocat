fn main() {
    println!("cargo:rerun-if-env-changed=KUROCAT_YY_THUNKS_OBJ");
    println!("cargo:rerun-if-env-changed=KUROCAT_VC_LTL_LIB");
    println!("cargo:rerun-if-env-changed=KUROCAT_WIN7_OLE32_SHIM_OBJ");
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
