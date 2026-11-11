# DKG semantic runtime (Rust/Wasm)

This workspace contains the deterministic, host-capability-free portion of the
DKG semantic runtime: bounded declarative S-expression parsing, canonical plan
compilation and re-admission, logical processes, bounded typed mailboxes,
cooperative scheduling, OTP-inspired restart semantics, monotonic budgets,
pure authority/effect models, stable byte envelopes, snapshots, and
integrity-verifiable Wasm bindings.

The Wasm module has no filesystem, network, clock, process, credential, or
adapter imports. Native and Wasm builds run the same supervised-kernel
conformance vector. Real credentials, policy evaluation, persistence, DKG I/O,
protected adapter dispatch, and reconciliation remain TypeScript host
responsibilities under `packages/semantic-runtime`.
