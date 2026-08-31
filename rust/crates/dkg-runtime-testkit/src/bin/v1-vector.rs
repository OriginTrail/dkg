//! Emits the native supervised-kernel conformance digest as one JSON line.

use dkg_runtime_kernel::supervised_kernel_conformance_vector;

fn main() {
    let digest = supervised_kernel_conformance_vector();
    println!("{{\"digestHex\":\"{}\"}}", hex(&digest));
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("String writes are infallible");
    }
    output
}
