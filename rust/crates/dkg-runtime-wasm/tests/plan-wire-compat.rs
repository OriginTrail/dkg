//! Compatibility vectors captured from PR #3427 head 0e573e63 before executor extraction.
use dkg_ir::{AdmissionLimits, parse_strategy_bytes};
use dkg_runtime_codec::{
    PlanApplyInput, encode_admit_request, encode_apply_plan_request, encode_compile_request,
    encode_empty_request, encode_start_plan_request, message_type,
};
use dkg_runtime_wasm::{
    runtime_admit_plan, runtime_apply_plan, runtime_compile_strategy, runtime_drop_plan,
    runtime_inspect_plan, runtime_start_plan,
};
use dkg_strategy_compiler::{AdapterRegistry, compile_strategy};

const SOURCE: &str = r#"(strategy transport/compat
  (version "1.0.0") (scope network:devnet) (goal preserve-wire)
  (supervise one-for-one (max-restarts 2) (window-ms 60000)
    (parallel (max 2)
      (delegate observer (emit started))
      (delegate reader (grant dkg.query) (call dkg/query@1 "urn:query:compat")))))"#;

fn record(name: &str, bytes: Vec<u8>) {
    use std::fmt::Write;
    let mut hex = String::new();
    for byte in bytes {
        write!(hex, "{byte:02x}").unwrap();
    }
    let expected = include_str!("fixtures/plan-v1.txt")
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{name}=")))
        .expect("frozen wire case exists");
    assert_eq!(hex, expected, "CBOR v1 changed at {name}");
}

#[test]
fn cbor_plan_v1_preserves_pre_refactor_bytes() {
    let ast = parse_strategy_bytes(SOURCE.as_bytes(), AdmissionLimits::default()).unwrap();
    let plan = compile_strategy(&ast, &AdapterRegistry::v1()).unwrap();
    record(
        "compile",
        runtime_compile_strategy(&encode_compile_request(7, SOURCE.as_bytes())),
    );
    record(
        "admit",
        runtime_admit_plan(&encode_admit_request(8, &plan.canonical_plan_cbor)),
    );
    record(
        "start",
        runtime_start_plan(&encode_start_plan_request(
            9,
            &plan.canonical_plan_cbor,
            123,
        )),
    );
    record(
        "inspect-start",
        runtime_inspect_plan(1, &encode_empty_request(10, message_type::INSPECT_PLAN)),
    );
    record(
        "effect",
        runtime_apply_plan(1, &encode_apply_plan_request(11, &PlanApplyInput::Continue)),
    );
    record(
        "effect-required",
        runtime_apply_plan(1, &encode_apply_plan_request(12, &PlanApplyInput::Continue)),
    );
    record(
        "effect-mismatch",
        runtime_apply_plan(
            1,
            &encode_apply_plan_request(
                13,
                &PlanApplyInput::EffectResult {
                    effect_id: 99,
                    result: Ok("wrong".into()),
                },
            ),
        ),
    );
    record(
        "completed",
        runtime_apply_plan(
            1,
            &encode_apply_plan_request(
                14,
                &PlanApplyInput::EffectResult {
                    effect_id: 1,
                    result: Ok("private-result".into()),
                },
            ),
        ),
    );
    record(
        "inspect-completed",
        runtime_inspect_plan(1, &encode_empty_request(15, message_type::INSPECT_PLAN)),
    );
    record(
        "drop",
        runtime_drop_plan(1, &encode_empty_request(16, message_type::DROP_PLAN)),
    );
    record(
        "stale",
        runtime_inspect_plan(1, &encode_empty_request(17, message_type::INSPECT_PLAN)),
    );
    record(
        "malformed-source",
        runtime_compile_strategy(&encode_compile_request(18, b"(")),
    );
    record(
        "malformed-plan",
        runtime_admit_plan(&encode_admit_request(19, &[0xff])),
    );
}
