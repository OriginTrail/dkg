//! The typed API preserves pending-effect ownership and partition isolation.

use dkg_runtime_executor::{PlanStep, admit, compile, start};
use dkg_runtime_types::PlanApplyInput;

const SOURCE: &[u8] = br#"(strategy typed/partitions
  (version "1.0.0") (scope network:devnet) (goal isolate-effects)
  (supervise one-for-one (max-restarts 2) (window-ms 60000)
    (parallel (max 2)
      (delegate observer (emit started))
      (delegate reader (grant dkg.query) (call dkg/query@1 "urn:query:private")))))"#;

#[test]
fn pending_effect_identity_and_failure_are_scoped_to_the_owned_partition() {
    let plan = compile(SOURCE).expect("source compiles");
    let readmitted = admit(&plan.canonical_plan_cbor).unwrap();
    assert_eq!(readmitted.canonical_hash, plan.canonical_hash);
    assert_eq!(readmitted.canonical_plan_cbor, plan.canonical_plan_cbor);
    let mut first = start(&plan.canonical_plan_cbor, 123).unwrap();
    let mut second = start(&plan.canonical_plan_cbor, 123).unwrap();
    let initial = second.inspect();
    assert_eq!(first.inspect(), initial);

    let PlanStep::EffectRequested(effect) = first.advance(PlanApplyInput::Continue).unwrap() else {
        panic!("query effect is required");
    };
    assert_eq!(effect.operation, "dkg/query");
    assert_eq!(effect.arguments, ["t:urn:query:private"]);
    assert_eq!(effect.process_id, initial.agents[1].process_id);
    assert_eq!(
        second.inspect(),
        initial,
        "another partition has not advanced"
    );

    let waiting = first.inspect();
    assert_eq!(waiting.agents[1].status, "waiting");
    let error = first
        .advance(PlanApplyInput::EffectResult {
            effect_id: effect.effect_id + 1,
            result: Ok("another invocation's result".into()),
        })
        .unwrap_err();
    assert_eq!(error.code, "PLAN_EFFECT_ID_MISMATCH");
    assert_eq!(
        first.inspect(),
        waiting,
        "mismatched input keeps pending ownership"
    );

    let PlanStep::Completed(completion) = first
        .advance(PlanApplyInput::EffectResult {
            effect_id: effect.effect_id,
            result: Ok("private-result".into()),
        })
        .unwrap()
    else {
        panic!("authorized effect completes");
    };
    assert_eq!(completion.events[0].value, "s:started");
    assert_eq!(completion.outputs[0].value, "private-result");
    assert!(
        first
            .inspect()
            .agents
            .iter()
            .all(|agent| agent.status == "terminated")
    );

    let PlanStep::EffectRequested(other) = second.advance(PlanApplyInput::Continue).unwrap() else {
        panic!("the other partition has its own pending query");
    };
    let error = second
        .advance(PlanApplyInput::EffectResult {
            effect_id: other.effect_id,
            result: Err("revoked".into()),
        })
        .unwrap_err();
    assert_eq!(error.code, "PLAN_HOST_EFFECT_FAILED");
    assert_eq!(error.category, "execution");
    assert_eq!(
        first.advance(PlanApplyInput::Continue).unwrap(),
        PlanStep::Completed(completion)
    );
}

#[test]
fn start_always_readmits_untrusted_plan_bytes() {
    let error = start(&[0xff], 123)
        .err()
        .expect("malformed plan is rejected");
    assert_eq!(error.code, "PLAN_MALFORMED");
    assert_eq!(error.category, "admission");
    assert!(compile(b"(").is_err());
}
