//! Thin `wasm-bindgen` handle table around the explicit runtime kernel.

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};

use dkg_ir::{AdmissionLimits, parse_strategy_bytes};
use dkg_runtime_codec::{
    CodecError, PlanApplyInput, PlanValue, StartedAgentSummary, decode_admit_request,
    decode_apply_plan_request, decode_compile_request, decode_create_request, decode_empty_request,
    decode_event_request, decode_restore_request, decode_snapshot, decode_start_plan_request,
    encode_admitted_plan, encode_compile_diagnostics, encode_compile_success, encode_error,
    encode_handle, encode_inspection, encode_plan_completed, encode_plan_effect_request,
    encode_runtime_error, encode_snapshot, encode_started_plan_inspection,
    encode_started_plan_receipt, encode_status, encode_step_output, encode_success, message_type,
};
use dkg_runtime_kernel::{
    BudgetKind, CapabilityRef, ChildSpec, ChildSpecId, MailboxSpec, OverflowPolicy, ProcessId,
    ProcessStatus, RestartClass, RestartStrategy, RuntimeError, RuntimeState, SupervisedKernel,
    TerminationReason, supervised_kernel_conformance_vector,
};
use dkg_runtime_types::{ABI_VERSION, SCHEMA_VERSION};
use dkg_strategy_compiler::{
    AdapterRegistry, AdmittedPlan, EffectClass, PlanExpr, RegisteredCall, SupervisorStrategy,
    admit_canonical_plan, compile_strategy,
};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

thread_local! {
    static RUNTIMES: RefCell<RuntimeHandleTable> = RefCell::new(RuntimeHandleTable::default());
    static PLAN_RUNTIMES: RefCell<PlanRuntimeHandleTable> = RefCell::new(PlanRuntimeHandleTable::default());
}

#[derive(Default)]
struct RuntimeHandleTable {
    states: Vec<Option<RuntimeState>>,
}

struct PlanRuntime {
    canonical_hash: [u8; 32],
    strategy_ref: String,
    kernel: SupervisedKernel,
    agents: Vec<PlanAgent>,
    pending: Option<(u64, usize)>,
    next_effect_id: u64,
    events: Vec<PlanValue>,
    outputs: Vec<PlanValue>,
}

struct PlanAgent {
    role: String,
    process_id: ProcessId,
    instructions: Vec<PlanInstruction>,
    cursor: usize,
}

#[derive(Clone)]
enum PlanInstruction {
    Emit(String),
    Call(RegisteredCall),
}

#[derive(Default)]
struct PlanRuntimeHandleTable {
    states: Vec<Option<PlanRuntime>>,
}

enum ApplyFailure {
    InvalidHandle,
    Runtime(RuntimeError),
}

impl RuntimeHandleTable {
    fn insert(&mut self, state: RuntimeState) -> Result<u32, &'static str> {
        if let Some((index, slot)) = self
            .states
            .iter_mut()
            .enumerate()
            .find(|(_, state)| state.is_none())
        {
            *slot = Some(state);
            return u32::try_from(index + 1).map_err(|_| "LIMIT_RUNTIME_HANDLES");
        }
        let handle = u32::try_from(self.states.len() + 1).map_err(|_| "LIMIT_RUNTIME_HANDLES")?;
        self.states.push(Some(state));
        Ok(handle)
    }

    fn get(&self, handle: u32) -> Option<&RuntimeState> {
        let index = usize::try_from(handle).ok()?.checked_sub(1)?;
        self.states.get(index)?.as_ref()
    }

    fn get_mut(&mut self, handle: u32) -> Option<&mut RuntimeState> {
        let index = usize::try_from(handle).ok()?.checked_sub(1)?;
        self.states.get_mut(index)?.as_mut()
    }

    fn drop_handle(&mut self, handle: u32) -> bool {
        let Some(index) = usize::try_from(handle)
            .ok()
            .and_then(|value| value.checked_sub(1))
        else {
            return false;
        };
        self.states
            .get_mut(index)
            .is_some_and(|state| state.take().is_some())
    }
}

impl PlanRuntimeHandleTable {
    fn insert(&mut self, state: PlanRuntime) -> Result<u32, &'static str> {
        if let Some((index, slot)) = self
            .states
            .iter_mut()
            .enumerate()
            .find(|(_, state)| state.is_none())
        {
            *slot = Some(state);
            return u32::try_from(index + 1).map_err(|_| "LIMIT_PLAN_HANDLES");
        }
        let handle = u32::try_from(self.states.len() + 1).map_err(|_| "LIMIT_PLAN_HANDLES")?;
        self.states.push(Some(state));
        Ok(handle)
    }

    fn get(&self, handle: u32) -> Option<&PlanRuntime> {
        let index = usize::try_from(handle).ok()?.checked_sub(1)?;
        self.states.get(index)?.as_ref()
    }

    fn get_mut(&mut self, handle: u32) -> Option<&mut PlanRuntime> {
        let index = usize::try_from(handle).ok()?.checked_sub(1)?;
        self.states.get_mut(index)?.as_mut()
    }

    fn drop_handle(&mut self, handle: u32) -> bool {
        let Some(index) = usize::try_from(handle)
            .ok()
            .and_then(|value| value.checked_sub(1))
        else {
            return false;
        };
        self.states
            .get_mut(index)
            .is_some_and(|state| state.take().is_some())
    }
}

/// Returns `(ABI_VERSION << 16) | SCHEMA_VERSION`.
#[wasm_bindgen]
#[must_use]
pub fn runtime_abi_version() -> u32 {
    u32::from(ABI_VERSION) << 16 | u32::from(SCHEMA_VERSION)
}

/// Compiles bounded declarative source using the same Rust implementation
/// used by native tooling. Source is parsed as data and never evaluated.
#[wasm_bindgen]
#[must_use]
pub fn runtime_compile_strategy(input: &[u8]) -> Vec<u8> {
    let (request_id, source) = match decode_compile_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::COMPILE, error),
    };
    let ast = match parse_strategy_bytes(&source, AdmissionLimits::default()) {
        Ok(ast) => ast,
        Err(diagnostics) => {
            return compile_diagnostics(request_id, &diagnostics);
        }
    };
    let plan = match compile_strategy(&ast, &AdapterRegistry::v1()) {
        Ok(plan) => plan,
        Err(diagnostics) => {
            return compile_diagnostics(request_id, &diagnostics);
        }
    };
    success_or_codec_error(
        request_id,
        message_type::COMPILE,
        encode_compile_success(&plan),
    )
}

/// Re-decodes and re-analyzes canonical plan bytes inside the execution Wasm
/// boundary. A matching hash alone is deliberately insufficient.
#[wasm_bindgen]
#[must_use]
pub fn runtime_admit_plan(input: &[u8]) -> Vec<u8> {
    let (request_id, bytes) = match decode_admit_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::ADMIT, error),
    };
    let plan = match admit_canonical_plan(&bytes, &AdapterRegistry::v1()) {
        Ok(plan) => plan,
        Err(error) => {
            return encode_error(
                request_id,
                message_type::ADMIT,
                error.code(),
                "admission",
                false,
            );
        }
    };
    success_or_codec_error(request_id, message_type::ADMIT, encode_admitted_plan(&plan))
}

/// Re-admits and materializes a supervised plan into live logical processes.
/// The initial executor supports only ordered emits and one investigator call
/// per agent; every other expression or external operation fails closed.
#[wasm_bindgen]
#[must_use]
pub fn runtime_start_plan(input: &[u8]) -> Vec<u8> {
    let (request_id, bytes, logical_time) = match decode_start_plan_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::START_PLAN, error),
    };
    let plan = match admit_canonical_plan(&bytes, &AdapterRegistry::v1()) {
        Ok(plan) => plan,
        Err(error) => {
            return encode_error(
                request_id,
                message_type::START_PLAN,
                error.code(),
                "admission",
                false,
            );
        }
    };
    let state = match materialize_plan(&plan, logical_time) {
        Ok(state) => state,
        Err(code) => {
            return encode_error(
                request_id,
                message_type::START_PLAN,
                code,
                "materialization",
                false,
            );
        }
    };
    let handle = match PLAN_RUNTIMES.with(|table| table.borrow_mut().insert(state)) {
        Ok(handle) => handle,
        Err(code) => {
            return encode_error(request_id, message_type::START_PLAN, code, "limit", false);
        }
    };
    let receipt = PLAN_RUNTIMES.with(|table| {
        let table = table.borrow();
        let state = table.get(handle).ok_or("INVALID_PLAN_HANDLE")?;
        encode_plan_receipt(handle, state).map_err(CodecError::code)
    });
    match receipt {
        Ok(receipt) => encode_success(request_id, message_type::START_PLAN, &receipt),
        Err(code) => encode_error(
            request_id,
            message_type::START_PLAN,
            code,
            "materialization",
            false,
        ),
    }
}

/// Drives the admitted plan inside Wasm until it completes or requests one
/// external operation. External results are explicit inputs on the next call.
#[wasm_bindgen]
#[must_use]
pub fn runtime_apply_plan(handle: u32, input: &[u8]) -> Vec<u8> {
    let (request_id, input) = match decode_apply_plan_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::APPLY_PLAN, error),
    };
    let result = PLAN_RUNTIMES.with(|table| {
        table
            .borrow_mut()
            .get_mut(handle)
            .ok_or("INVALID_PLAN_HANDLE")?
            .apply(input)
    });
    match result {
        Ok(output) => encode_success(request_id, message_type::APPLY_PLAN, &output),
        Err(code) => encode_error(
            request_id,
            message_type::APPLY_PLAN,
            code,
            "execution",
            false,
        ),
    }
}

/// Returns redaction-safe state for a materialized supervised plan.
#[wasm_bindgen]
#[must_use]
pub fn runtime_inspect_plan(handle: u32, input: &[u8]) -> Vec<u8> {
    let request_id = match decode_empty_request(input, message_type::INSPECT_PLAN) {
        Ok(request_id) => request_id,
        Err(error) => return codec_error(0, message_type::INSPECT_PLAN, error),
    };
    let result = PLAN_RUNTIMES.with(|table| {
        let table = table.borrow();
        let state = table.get(handle).ok_or("INVALID_PLAN_HANDLE")?;
        encode_plan_inspection(state).map_err(CodecError::code)
    });
    match result {
        Ok(inspection) => encode_success(request_id, message_type::INSPECT_PLAN, &inspection),
        Err(code) => encode_error(
            request_id,
            message_type::INSPECT_PLAN,
            code,
            "materialization",
            false,
        ),
    }
}

/// Drops one materialized plan handle. Repeated drops return `false`.
#[wasm_bindgen]
#[must_use]
pub fn runtime_drop_plan(handle: u32, input: &[u8]) -> Vec<u8> {
    let request_id = match decode_empty_request(input, message_type::DROP_PLAN) {
        Ok(request_id) => request_id,
        Err(error) => return codec_error(0, message_type::DROP_PLAN, error),
    };
    let removed = PLAN_RUNTIMES.with(|table| table.borrow_mut().drop_handle(handle));
    success_or_codec_error(request_id, message_type::DROP_PLAN, encode_status(removed))
}

/// Creates one empty runtime state and returns an encoded numeric handle.
#[wasm_bindgen]
#[must_use]
pub fn runtime_create(input: &[u8]) -> Vec<u8> {
    let (request_id, config) = match decode_create_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::CREATE, error),
    };
    let state = match RuntimeState::new(config) {
        Ok(state) => state,
        Err(error) => return encode_runtime_error(request_id, message_type::CREATE, error),
    };
    let handle = match RUNTIMES.with(|table| table.borrow_mut().insert(state)) {
        Ok(handle) => handle,
        Err(code) => return encode_error(request_id, message_type::CREATE, code, "limit", false),
    };
    success_or_codec_error(request_id, message_type::CREATE, encode_handle(handle))
}

/// Applies one bounded event to an existing runtime handle.
#[wasm_bindgen]
#[must_use]
pub fn runtime_apply_event(handle: u32, input: &[u8]) -> Vec<u8> {
    let (request_id, event) = match decode_event_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::APPLY, error),
    };
    let result = RUNTIMES.with(|table| {
        let mut table = table.borrow_mut();
        let state = table.get_mut(handle).ok_or(ApplyFailure::InvalidHandle)?;
        state.apply_event(&event).map_err(ApplyFailure::Runtime)
    });
    let output = match result {
        Ok(output) => output,
        Err(ApplyFailure::InvalidHandle) => {
            return encode_error(
                request_id,
                message_type::APPLY,
                "INVALID_HANDLE",
                "runtime",
                false,
            );
        }
        Err(ApplyFailure::Runtime(error)) => {
            return encode_runtime_error(request_id, message_type::APPLY, error);
        }
    };
    success_or_codec_error(request_id, message_type::APPLY, encode_step_output(&output))
}

/// Returns an encoded snapshot for an existing runtime handle.
#[wasm_bindgen]
#[must_use]
pub fn runtime_snapshot(handle: u32, input: &[u8]) -> Vec<u8> {
    let request_id = match decode_empty_request(input, message_type::SNAPSHOT) {
        Ok(request_id) => request_id,
        Err(error) => return codec_error(0, message_type::SNAPSHOT, error),
    };
    let result = RUNTIMES.with(|table| {
        table
            .borrow()
            .get(handle)
            .ok_or("INVALID_HANDLE")
            .and_then(|state| encode_snapshot(state).map_err(CodecError::code))
    });
    match result {
        Ok(snapshot) => encode_success(request_id, message_type::SNAPSHOT, &snapshot),
        Err(code) => encode_error(request_id, message_type::SNAPSHOT, code, "snapshot", false),
    }
}

/// Restores snapshot bytes into a new runtime handle.
#[wasm_bindgen]
#[must_use]
pub fn runtime_restore(input: &[u8]) -> Vec<u8> {
    let (request_id, snapshot) = match decode_restore_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::RESTORE, error),
    };
    let state = match decode_snapshot(&snapshot) {
        Ok(state) => state,
        Err(error) => return codec_error(request_id, message_type::RESTORE, error),
    };
    let handle = match RUNTIMES.with(|table| table.borrow_mut().insert(state)) {
        Ok(handle) => handle,
        Err(code) => return encode_error(request_id, message_type::RESTORE, code, "limit", false),
    };
    success_or_codec_error(request_id, message_type::RESTORE, encode_handle(handle))
}

/// Returns redaction-safe state for an existing runtime handle.
#[wasm_bindgen]
#[must_use]
pub fn runtime_inspect(handle: u32, input: &[u8]) -> Vec<u8> {
    let request_id = match decode_empty_request(input, message_type::INSPECT) {
        Ok(request_id) => request_id,
        Err(error) => return codec_error(0, message_type::INSPECT, error),
    };
    let result = RUNTIMES.with(|table| {
        table
            .borrow()
            .get(handle)
            .ok_or("INVALID_HANDLE")
            .and_then(|state| encode_inspection(state).map_err(CodecError::code))
    });
    match result {
        Ok(inspection) => encode_success(request_id, message_type::INSPECT, &inspection),
        Err(code) => encode_error(request_id, message_type::INSPECT, code, "runtime", false),
    }
}

/// Drops one runtime handle. A second drop returns `false` rather than trapping.
#[wasm_bindgen]
#[must_use]
pub fn runtime_drop(handle: u32, input: &[u8]) -> Vec<u8> {
    let request_id = match decode_empty_request(input, message_type::DROP) {
        Ok(request_id) => request_id,
        Err(error) => return codec_error(0, message_type::DROP, error),
    };
    let removed = RUNTIMES.with(|table| table.borrow_mut().drop_handle(handle));
    success_or_codec_error(request_id, message_type::DROP, encode_status(removed))
}

/// Reports current WebAssembly linear-memory bytes for observability.
#[wasm_bindgen]
#[must_use]
pub fn runtime_memory_bytes() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let pages = core::arch::wasm32::memory_size(0);
        return u32::try_from(pages.saturating_mul(65_536)).unwrap_or(u32::MAX);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Phase 0 watchdog-only operation. The Worker refuses it unless explicitly
/// booted with test operations enabled.
#[wasm_bindgen]
pub fn runtime_phase0_test_hang() {
    loop {
        std::hint::spin_loop();
    }
}

/// Phase 0 trap-only operation used by the Worker replacement test.
#[wasm_bindgen]
pub fn runtime_phase0_test_trap() {
    #[cfg(target_arch = "wasm32")]
    core::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    panic!("phase0 test trap");
}

/// Test-only native/Wasm conformance vector for the V1 supervised kernel.
/// The Worker refuses this operation unless explicitly booted in test mode.
#[wasm_bindgen]
#[must_use]
pub fn runtime_v1_conformance_vector() -> Vec<u8> {
    supervised_kernel_conformance_vector().to_vec()
}

impl PlanRuntime {
    fn apply(&mut self, input: PlanApplyInput) -> Result<Vec<u8>, &'static str> {
        match (self.pending.take(), input) {
            (None, PlanApplyInput::Continue) => {}
            (Some(pending), PlanApplyInput::Continue) => {
                self.pending = Some(pending);
                return Err("PLAN_EFFECT_RESULT_REQUIRED");
            }
            (None, PlanApplyInput::EffectResult { .. }) => {
                return Err("PLAN_EFFECT_NOT_PENDING");
            }
            (Some((expected, agent_index)), PlanApplyInput::EffectResult { effect_id, result }) => {
                if expected != effect_id {
                    self.pending = Some((expected, agent_index));
                    return Err("PLAN_EFFECT_ID_MISMATCH");
                }
                let agent = &mut self.agents[agent_index];
                if let Ok(value) = result {
                    self.kernel
                        .budget_mut(agent.process_id)
                        .and_then(|budget| budget.settle(BudgetKind::ModelTokens, 512, 512))
                        .map_err(|_| "PLAN_BUDGET_SETTLEMENT")?;
                    agent.cursor += 1;
                    self.outputs.push(PlanValue {
                        role: agent.role.clone(),
                        process_id: agent.process_id.bytes(),
                        value,
                    });
                    if agent.cursor == agent.instructions.len() {
                        self.kernel
                            .terminate(agent.process_id, TerminationReason::NormalCompleted)
                            .map_err(|_| "PLAN_PROCESS_COMPLETION")?;
                    } else {
                        self.kernel
                            .wake(agent.process_id)
                            .map_err(|_| "PLAN_PROCESS_WAKE")?;
                    }
                } else {
                    self.kernel
                        .budget_mut(agent.process_id)
                        .and_then(|budget| budget.release(BudgetKind::ModelTokens, 512))
                        .map_err(|_| "PLAN_BUDGET_RELEASE")?;
                    self.kernel
                        .terminate(
                            agent.process_id,
                            TerminationReason::Failure("HOST_EFFECT_FAILED".into()),
                        )
                        .map_err(|_| "PLAN_PROCESS_FAILURE")?;
                    return Err("PLAN_HOST_EFFECT_FAILED");
                }
            }
        }

        loop {
            let Some(index) = self
                .agents
                .iter()
                .position(|agent| agent.cursor < agent.instructions.len())
            else {
                return encode_plan_completed(&self.events, &self.outputs)
                    .map_err(CodecError::code);
            };
            let instruction = self.agents[index].instructions[self.agents[index].cursor].clone();
            match instruction {
                PlanInstruction::Emit(value) => {
                    let agent = &mut self.agents[index];
                    agent.cursor += 1;
                    self.events.push(PlanValue {
                        role: agent.role.clone(),
                        process_id: agent.process_id.bytes(),
                        value,
                    });
                    if agent.cursor == agent.instructions.len() {
                        self.kernel
                            .terminate(agent.process_id, TerminationReason::NormalCompleted)
                            .map_err(|_| "PLAN_PROCESS_COMPLETION")?;
                    }
                }
                PlanInstruction::Call(call) => {
                    let agent = &self.agents[index];
                    self.kernel
                        .budget_mut(agent.process_id)
                        .and_then(|budget| budget.reserve(BudgetKind::ModelTokens, 512))
                        .map_err(|_| "PLAN_MODEL_BUDGET")?;
                    self.kernel
                        .wait(agent.process_id)
                        .map_err(|_| "PLAN_PROCESS_WAIT")?;
                    self.next_effect_id = self.next_effect_id.saturating_add(1);
                    self.pending = Some((self.next_effect_id, index));
                    return encode_plan_effect_request(
                        self.next_effect_id,
                        &agent.process_id.bytes(),
                        &call.operation,
                        call.version,
                        &call.arguments,
                    )
                    .map_err(CodecError::code);
                }
            }
        }
    }
}

fn materialize_plan(plan: &AdmittedPlan, logical_time: u64) -> Result<PlanRuntime, &'static str> {
    if !plan.approval_requirements.is_empty()
        || plan
            .required_capabilities
            .iter()
            .any(|value| value != "agent.invoke.investigator")
        || plan
            .effect_upper_bound
            .iter()
            .any(|value| *value != EffectClass::ModelInvocation)
        || plan
            .adapter_versions
            .iter()
            .any(|(operation, version)| operation != "agent/investigate" || *version != 1)
    {
        return Err("PLAN_MATERIALIZATION_UNSUPPORTED_EFFECT");
    }
    let PlanExpr::Sequence(root_children) = &plan.root.value else {
        return Err("PLAN_MATERIALIZATION_ROOT");
    };
    if root_children.len() != 1 {
        return Err("PLAN_MATERIALIZATION_ROOT");
    }
    let PlanExpr::Supervise {
        strategy,
        max_restarts,
        window_ms,
        body,
    } = &root_children[0].value
    else {
        return Err("PLAN_MATERIALIZATION_SUPERVISOR_REQUIRED");
    };
    let mut definitions = Vec::new();
    collect_plan_agents(&body.value, &mut definitions)?;
    if definitions.is_empty() || definitions.len() > 64 {
        return Err("PLAN_MATERIALIZATION_AGENT_COUNT");
    }
    let mut unique = BTreeSet::new();
    if definitions
        .iter()
        .any(|(role, _)| !unique.insert(role.clone()))
    {
        return Err("PLAN_MATERIALIZATION_DUPLICATE_ROLE");
    }

    let supervisor_id = ProcessId::new(derive_id(
        b"DKG-SEMANTIC-SUPERVISOR-V1\0",
        &plan.canonical_hash,
        "root",
        0,
    ));
    let mut agents = Vec::with_capacity(definitions.len());
    let mut children = Vec::with_capacity(definitions.len());
    for (index, (role, instructions)) in definitions.into_iter().enumerate() {
        let index = u32::try_from(index).map_err(|_| "PLAN_MATERIALIZATION_AGENT_COUNT")?;
        let model_call = instructions
            .iter()
            .any(|value| matches!(value, PlanInstruction::Call(_)));
        let (process_id, child) = materialize_agent(
            &plan.canonical_hash,
            &role,
            index,
            *max_restarts,
            model_call,
        );
        children.push((process_id, child));
        agents.push(PlanAgent {
            role,
            process_id,
            instructions,
            cursor: 0,
        });
    }
    let mut kernel = SupervisedKernel::new(logical_time);
    kernel
        .spawn_supervisor(
            supervisor_id,
            match strategy {
                SupervisorStrategy::OneForOne => RestartStrategy::OneForOne,
                SupervisorStrategy::RestForOne => RestartStrategy::RestForOne,
                SupervisorStrategy::OneForAll => RestartStrategy::OneForAll,
            },
            *max_restarts,
            *window_ms,
            children,
        )
        .map_err(|_| "PLAN_MATERIALIZATION_KERNEL_REJECTED")?;
    Ok(PlanRuntime {
        canonical_hash: plan.canonical_hash,
        strategy_ref: plan.strategy_ref.clone(),
        kernel,
        agents,
        pending: None,
        next_effect_id: 0,
        events: Vec::new(),
        outputs: Vec::new(),
    })
}

fn materialize_agent(
    plan_hash: &[u8; 32],
    role: &str,
    index: u32,
    max_restarts: u16,
    model_call: bool,
) -> (ProcessId, ChildSpec) {
    let process_id = ProcessId::new(derive_id(
        b"DKG-SEMANTIC-PROCESS-V1\0",
        plan_hash,
        role,
        index,
    ));
    (
        process_id,
        ChildSpec {
            id: ChildSpecId::new(derive_id(
                b"DKG-SEMANTIC-CHILD-SPEC-V1\0",
                plan_hash,
                role,
                index,
            )),
            restart_class: RestartClass::Transient,
            mailbox: MailboxSpec {
                schema_id: derive_id(b"DKG-SEMANTIC-MAILBOX-V1\0", plan_hash, role, index),
                schema_version: SCHEMA_VERSION,
                max_count: 64,
                max_bytes: 512 * 1024,
                max_message_bytes: 64 * 1024,
                reserved_control_count: 4,
                reserved_control_bytes: 4 * 1024,
                overflow: OverflowPolicy::Reject,
            },
            shutdown_timeout_ms: 5_000,
            capability_ref: CapabilityRef::new(derive_id(
                b"DKG-SEMANTIC-NO-AUTHORITY-V1\0",
                plan_hash,
                role,
                index,
            )),
            budget_limits: BTreeMap::from([
                (BudgetKind::Steps, 10_000),
                (BudgetKind::ModelTokens, if model_call { 512 } else { 0 }),
                (BudgetKind::ToolCalls, 0),
                (BudgetKind::Restarts, u64::from(max_restarts)),
            ]),
        },
    )
}

fn collect_plan_agents(
    expression: &PlanExpr,
    agents: &mut Vec<(String, Vec<PlanInstruction>)>,
) -> Result<(), &'static str> {
    match expression {
        PlanExpr::Sequence(children) | PlanExpr::Parallel { children, .. } => {
            for child in children {
                collect_plan_agents(&child.value, agents)?;
            }
            Ok(())
        }
        PlanExpr::Delegate { role, grants, body } => {
            if grants
                .iter()
                .any(|value| value != "agent.invoke.investigator")
            {
                return Err("PLAN_MATERIALIZATION_AGENT_GRANT");
            }
            let mut instructions = Vec::new();
            collect_instructions(&body.value, &mut instructions)?;
            if instructions.is_empty()
                || instructions
                    .iter()
                    .filter(|value| matches!(value, PlanInstruction::Call(_)))
                    .count()
                    > 1
            {
                return Err("PLAN_MATERIALIZATION_AGENT_BODY");
            }
            agents.push((role.clone(), instructions));
            Ok(())
        }
        _ => Err("PLAN_MATERIALIZATION_TOPOLOGY"),
    }
}

fn collect_instructions(
    expression: &PlanExpr,
    instructions: &mut Vec<PlanInstruction>,
) -> Result<(), &'static str> {
    match expression {
        PlanExpr::Emit(value) => instructions.push(PlanInstruction::Emit(value.clone())),
        PlanExpr::Call(call) if call.operation == "agent/investigate" && call.version == 1 => {
            instructions.push(PlanInstruction::Call(call.clone()));
        }
        PlanExpr::Sequence(children) => {
            for child in children {
                collect_instructions(&child.value, instructions)?;
            }
        }
        _ => return Err("PLAN_MATERIALIZATION_AGENT_BODY"),
    }
    Ok(())
}

fn derive_id(domain: &[u8], plan_hash: &[u8; 32], role: &str, index: u32) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(plan_hash);
    hasher.update(index.to_be_bytes());
    hasher.update(role.as_bytes());
    hasher.finalize().into()
}

fn encode_plan_receipt(handle: u32, state: &PlanRuntime) -> Result<Vec<u8>, CodecError> {
    encode_started_plan_receipt(
        handle,
        &state.canonical_hash,
        &state.strategy_ref,
        state.kernel.logical_time(),
        &state.kernel.state_digest(),
        &started_agent_summaries(state),
    )
}

fn encode_plan_inspection(state: &PlanRuntime) -> Result<Vec<u8>, CodecError> {
    encode_started_plan_inspection(
        &state.canonical_hash,
        &state.strategy_ref,
        state.kernel.logical_time(),
        &state.kernel.state_digest(),
        &started_agent_summaries(state),
    )
}

fn started_agent_summaries(state: &PlanRuntime) -> Vec<StartedAgentSummary> {
    state
        .agents
        .iter()
        .map(|agent| StartedAgentSummary {
            role: agent.role.clone(),
            process_id: agent.process_id.bytes(),
            status: state.kernel.process(agent.process_id).map_or(
                "missing",
                |process| match process.status {
                    ProcessStatus::Runnable => "runnable",
                    ProcessStatus::Waiting => "waiting",
                    ProcessStatus::Cancelling { .. } => "cancelling",
                    ProcessStatus::Terminated(_) => "terminated",
                },
            ),
        })
        .collect()
}

fn success_or_codec_error(
    request_id: u64,
    operation: u16,
    result: Result<Vec<u8>, CodecError>,
) -> Vec<u8> {
    match result {
        Ok(payload) => encode_success(request_id, operation, &payload),
        Err(error) => codec_error(request_id, operation, error),
    }
}

fn codec_error(request_id: u64, operation: u16, error: CodecError) -> Vec<u8> {
    encode_error(request_id, operation, error.code(), "codec", false)
}

fn compile_diagnostics(request_id: u64, diagnostics: &[dkg_ir::Diagnostic]) -> Vec<u8> {
    success_or_codec_error(
        request_id,
        message_type::COMPILE,
        encode_compile_diagnostics(diagnostics),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use dkg_runtime_codec::{
        decode_success, encode_create_request, encode_empty_request, encode_start_plan_request,
    };
    use dkg_runtime_types::{RuntimeConfig, RuntimePartitionId};

    #[test]
    fn native_handle_adapter_rejects_stale_handles_without_panicking() {
        let create = runtime_create(&encode_create_request(
            1,
            &RuntimeConfig {
                partition_id: RuntimePartitionId::new([1; 32]),
                max_events: 2,
                max_accumulator: 10,
            },
        ));
        let payload = decode_success(&create, message_type::CREATE)
            .expect("create success")
            .payload;
        let mut decoder = minicbor::Decoder::new(&payload);
        assert_eq!(decoder.array().unwrap(), Some(1));
        let handle = decoder.u32().unwrap();
        let drop_request = encode_empty_request(2, message_type::DROP);
        decode_success(&runtime_drop(handle, &drop_request), message_type::DROP)
            .expect("first drop success");
        decode_success(&runtime_drop(handle, &drop_request), message_type::DROP)
            .expect("idempotent drop response");
    }

    #[test]
    fn admitted_plan_materializes_two_runnable_agents() {
        let source = r#"
          (strategy smoke/two-agents
            (version "1.0.0")
            (scope network:devnet)
            (goal prove-two-live-agents)
            (supervise one-for-one (max-restarts 2) (window-ms 60000)
              (parallel (max 2)
                (delegate observer-alpha (emit alpha-started))
                (delegate observer-beta (emit beta-started)))))
        "#;
        let ast = parse_strategy_bytes(source.as_bytes(), AdmissionLimits::default())
            .expect("smoke source parses");
        let plan = compile_strategy(&ast, &AdapterRegistry::v1()).expect("smoke source admits");
        let started =
            runtime_start_plan(&encode_start_plan_request(10, &plan.canonical_plan_cbor, 0));
        let payload = decode_success(&started, message_type::START_PLAN)
            .expect("plan start success")
            .payload;
        let mut decoder = minicbor::Decoder::new(&payload);
        assert_eq!(decoder.array().unwrap(), Some(6));
        let handle = decoder.u32().unwrap();
        assert_eq!(decoder.bytes().unwrap(), plan.canonical_hash);
        assert_eq!(decoder.str().unwrap(), "smoke/two-agents@1.0.0");
        assert_eq!(decoder.u64().unwrap(), 0);
        let state_digest = decoder.bytes().unwrap().to_vec();
        assert_eq!(state_digest.len(), 32);
        assert_eq!(decoder.array().unwrap(), Some(2));
        let mut roles = Vec::new();
        for _ in 0..2 {
            assert_eq!(decoder.array().unwrap(), Some(3));
            roles.push(decoder.str().unwrap().to_string());
            assert_eq!(decoder.bytes().unwrap().len(), 32);
            assert_eq!(decoder.str().unwrap(), "runnable");
        }
        assert_eq!(roles, ["observer-alpha", "observer-beta"]);

        let inspection = runtime_inspect_plan(
            handle,
            &encode_empty_request(11, message_type::INSPECT_PLAN),
        );
        let inspection = decode_success(&inspection, message_type::INSPECT_PLAN)
            .expect("plan inspection success")
            .payload;
        let mut decoder = minicbor::Decoder::new(&inspection);
        assert_eq!(decoder.array().unwrap(), Some(5));
        assert_eq!(decoder.bytes().unwrap(), plan.canonical_hash);
        assert_eq!(decoder.str().unwrap(), "smoke/two-agents@1.0.0");
        assert_eq!(decoder.u64().unwrap(), 0);
        assert_eq!(decoder.bytes().unwrap(), state_digest);
        assert_eq!(decoder.array().unwrap(), Some(2));

        decode_success(
            &runtime_drop_plan(handle, &encode_empty_request(12, message_type::DROP_PLAN)),
            message_type::DROP_PLAN,
        )
        .expect("plan drop success");
    }
}
