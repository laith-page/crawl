use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=version.txt");
    let version = fs::read_to_string("version.txt")
        .unwrap_or_else(|_| "crawl dev (rust, dev, rustc)\n".to_string());
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"));
    fs::write(output.join("version.txt"), version).expect("generated version file");
}
