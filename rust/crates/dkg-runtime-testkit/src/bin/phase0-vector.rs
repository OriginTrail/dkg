//! Emits the canonical native Phase 0 vector as one JSON line.

use dkg_runtime_testkit::phase0_vector;

fn main() {
    let vector = phase0_vector();
    println!(
        "{{\"createRequestHex\":\"{}\",\"eventRequestHex\":\"{}\",\"stepOutputHex\":\"{}\",\"snapshotHex\":\"{}\"}}",
        hex(&vector.create_request),
        hex(&vector.event_request),
        hex(&vector.step_output),
        hex(&vector.snapshot),
    );
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("String writes are infallible");
    }
    output
}
