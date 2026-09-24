fn main() {
    // Expose the target triple to the crate so `which_sidecar` can find the
    // `src-tauri/binaries/<name>-<target>` files that Tauri does not copy
    // next to the executable during `tauri dev`.
    let target = std::env::var("TARGET").expect("cargo always sets TARGET for build scripts");
    println!("cargo:rustc-env=TARGET={target}");

    tauri_build::build()
}
