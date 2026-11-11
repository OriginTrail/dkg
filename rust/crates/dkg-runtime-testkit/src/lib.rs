//! Shared deterministic fixtures for native/Wasm conformance.

use dkg_runtime_codec::{
    encode_create_request, encode_event_request, encode_snapshot, encode_step_output,
};
use dkg_runtime_kernel::RuntimeState;
use dkg_runtime_types::{
    LogicalTime, RuntimeConfig, RuntimeEvent, RuntimeEventId, RuntimePartitionId,
};

/// A complete native Phase 0 golden vector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Phase0Vector {
    /// Encoded create envelope.
    pub create_request: Vec<u8>,
    /// Encoded event envelope.
    pub event_request: Vec<u8>,
    /// Encoded deterministic step output payload.
    pub step_output: Vec<u8>,
    /// Encoded post-transition snapshot.
    pub snapshot: Vec<u8>,
}

/// Produces the canonical vector used by Rust and Node/Wasm tests.
#[must_use]
pub fn phase0_vector() -> Phase0Vector {
    let config = RuntimeConfig {
        partition_id: RuntimePartitionId::new([0x11; 32]),
        max_events: 32,
        max_accumulator: 1_000_000,
    };
    let event = RuntimeEvent::Advance {
        event_id: RuntimeEventId::new([0x22; 32]),
        logical_time: LogicalTime(1_234),
        delta: 77,
    };
    let create_request = encode_create_request(1, &config);
    let event_request = encode_event_request(2, &event);
    let mut state = RuntimeState::new(config).expect("fixture config is valid");
    let output = state
        .apply_event(&event)
        .expect("fixture event is within bounds");
    Phase0Vector {
        create_request,
        event_request,
        step_output: encode_step_output(&output).expect("fixture output encodes"),
        snapshot: encode_snapshot(&state).expect("fixture snapshot encodes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use dkg_authority_model::{
        AttenuationRequest, CapabilityBudget, CapabilityGrant, VerbSet, attenuate,
    };
    use dkg_effect_model::{OutcomeState, can_transition, dispatch_allowed};
    use dkg_ir::{AdmissionLimits, parse_strategy};
    use dkg_runtime_codec::{decode_create_request, decode_event_request, decode_snapshot};
    use dkg_runtime_kernel::{
        BoundedMailbox, BudgetKind, CapabilityRef, ChildSpec, ChildSpecId, MailboxSpec,
        OverflowPolicy, ProcessId, RestartClass, RestartStrategy, SupervisedKernel,
        TerminationReason,
    };
    use dkg_runtime_types::{CapabilityId, ExecutionId};
    use dkg_strategy_compiler::{AdapterRegistry, EffectClass, compile_strategy};

    #[test]
    fn canonical_vector_round_trips() {
        let vector = phase0_vector();
        assert!(decode_create_request(&vector.create_request).is_ok());
        assert!(decode_event_request(&vector.event_request).is_ok());
        assert!(decode_snapshot(&vector.snapshot).is_ok());
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn listener_boy_vertical_slice_preserves_failure_and_authority_boundaries() {
        let source = r#"
          (strategy sre/keep-network-healthy
            (version "0.4.0")
            (scope network:testnet)
            (goal p95-latency-below-500ms)
            (sequence
              (supervise one-for-one (max-restarts 4) (window-ms 60000)
                (parallel (max 3)
                  (delegate log-investigator
                    (grant logs.read)
                    (observe logs/read@1 affected-nodes 50m))
                  (delegate network-investigator
                    (grant dkg.query)
                    (query dkg/query@1 network-topology))
                  (delegate history-investigator
                    (grant agent.invoke.investigator)
                    (call agent/investigate@1 prior-incidents))))
              (approve infrastructure-change)
              (delegate remediation-worker
                (grant infra.node.drain)
                (call infra/drain-node@1 node-17))
              (emit incident-trace)))
        "#;
        let ast = parse_strategy(source, AdmissionLimits::default()).expect("bounded strategy");
        let plan = compile_strategy(&ast, &AdapterRegistry::v1()).expect("admitted strategy");
        assert!(
            plan.effect_upper_bound
                .contains(&EffectClass::InfrastructureChange)
        );
        assert!(plan.required_capabilities.contains("infra.node.drain"));
        assert!(plan.resource_bounds.processes <= 1_024);

        let mut kernel = SupervisedKernel::new(1_000);
        kernel
            .spawn_supervisor(
                process_id(90),
                RestartStrategy::OneForOne,
                4,
                60_000,
                vec![
                    child(1, RestartClass::Transient, "logs"),
                    child(2, RestartClass::Transient, "topology"),
                    child(3, RestartClass::Transient, "history"),
                    child(4, RestartClass::Transient, "coding"),
                    child(5, RestartClass::Temporary, "remediation"),
                ],
            )
            .expect("runtime topology");
        kernel
            .budget_mut(process_id(2))
            .expect("network budget")
            .reserve(BudgetKind::ModelTokens, 500)
            .expect("token reservation");
        kernel
            .budget_mut(process_id(2))
            .expect("network budget")
            .settle(BudgetKind::ModelTokens, 500, 450)
            .expect("token settlement");
        let authority = kernel
            .process(process_id(2))
            .expect("network process")
            .capability_ref;
        let restart = kernel
            .terminate(process_id(2), TerminationReason::ProtocolViolation)
            .expect("invalid schema termination");
        assert!(restart.iter().any(|event| matches!(
            event,
            dkg_runtime_kernel::LifecycleEvent::Restarted { process, .. }
                if *process == process_id(2)
        )));
        let restarted = kernel
            .process(process_id(2))
            .expect("restarted network process");
        assert_eq!(restarted.capability_ref, authority);
        assert_eq!(
            restarted
                .budget
                .account(BudgetKind::ModelTokens)
                .expect("model budget")
                .consumed,
            450,
        );

        let remediation = kernel
            .terminate(
                process_id(5),
                TerminationReason::Failure("AMBIGUOUS_EFFECT".into()),
            )
            .expect("temporary worker termination");
        assert!(
            remediation.iter().all(|event| !matches!(
                event,
                dkg_runtime_kernel::LifecycleEvent::Restarted { .. }
            ))
        );

        assert!(dispatch_allowed(OutcomeState::Prepared));
        assert!(!dispatch_allowed(OutcomeState::Unknown));
        assert!(can_transition(
            OutcomeState::Unknown,
            OutcomeState::Reconciling
        ));
        assert!(can_transition(
            OutcomeState::Reconciling,
            OutcomeState::Reconciled
        ));

        let parent = CapabilityGrant {
            id: CapabilityId::new([1; 32]),
            execution_id: ExecutionId::new([2; 32]),
            verbs: VerbSet(0b11),
            resource_prefix: "network:testnet".into(),
            expires_at: LogicalTime(10_000),
            not_before: LogicalTime(1_000),
            policy_epoch: 41,
            budget: CapabilityBudget {
                calls: 10,
                spending_microunits: 50_000_000,
            },
            delegation_depth: 2,
            one_shot: true,
        };
        let child = attenuate(
            &parent,
            AttenuationRequest {
                id: CapabilityId::new([3; 32]),
                execution_id: ExecutionId::new([4; 32]),
                verbs: VerbSet(0b01),
                resource_prefix: "network:testnet/node-17".into(),
                expires_at: LogicalTime(5_000),
                not_before: LogicalTime(1_100),
                policy_epoch: 41,
                budget: CapabilityBudget {
                    calls: 1,
                    spending_microunits: 1_000,
                },
                one_shot: true,
            },
        )
        .expect("one-shot remediation authority is attenuated");
        assert_eq!(child.delegation_depth, 1);
        assert!(child.one_shot);
    }

    fn process_id(value: u8) -> ProcessId {
        ProcessId::new([value; 32])
    }

    fn child(value: u8, restart: RestartClass, label: &str) -> (ProcessId, ChildSpec) {
        let mut schema = [0u8; 32];
        schema[..label.len()].copy_from_slice(label.as_bytes());
        let mailbox = MailboxSpec {
            schema_id: schema,
            schema_version: 1,
            max_count: 64,
            max_bytes: 512 * 1024,
            max_message_bytes: 64 * 1024,
            reserved_control_count: 4,
            reserved_control_bytes: 4 * 1024,
            overflow: OverflowPolicy::ShedLowPriority {
                shed_from: dkg_runtime_kernel::Priority::Telemetry,
            },
        };
        BoundedMailbox::new(mailbox.clone()).expect("listener mailbox bounds");
        (
            process_id(value),
            ChildSpec {
                id: ChildSpecId::new([value; 32]),
                restart_class: restart,
                mailbox,
                shutdown_timeout_ms: 5_000,
                capability_ref: CapabilityRef::new([value; 32]),
                budget_limits: BTreeMap::from([
                    (BudgetKind::Steps, 10_000),
                    (BudgetKind::ModelTokens, 250_000),
                    (BudgetKind::ToolCalls, 200),
                    (BudgetKind::Restarts, 4),
                ]),
            },
        )
    }
}
