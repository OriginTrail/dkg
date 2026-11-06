//! Thin `wasm-bindgen` handle table around the explicit runtime kernel.

use std::cell::RefCell;

#[cfg(test)]
use dkg_ir::{AdmissionLimits, parse_strategy_bytes};
use dkg_runtime_codec::{
    CodecError, decode_admit_request, decode_apply_plan_request, decode_compile_request,
    decode_create_request, decode_empty_request, decode_event_request, decode_restore_request,
    decode_snapshot, decode_start_plan_request, encode_admitted_plan, encode_compile_diagnostics,
    encode_compile_success, encode_error, encode_handle, encode_inspection, encode_plan_completed,
    encode_plan_effect_request, encode_runtime_error, encode_snapshot,
    encode_started_plan_inspection, encode_started_plan_receipt, encode_status, encode_step_output,
    encode_success, message_type,
};
use dkg_runtime_executor::{self as executor, ExecutorError, PlanRuntime, PlanStep};
use dkg_runtime_kernel::{RuntimeError, RuntimeState, supervised_kernel_conformance_vector};
use dkg_runtime_types::{ABI_VERSION, SCHEMA_VERSION};
#[cfg(test)]
use dkg_strategy_compiler::{AdapterRegistry, compile_strategy};
use wasm_bindgen::prelude::*;

thread_local! {
    static RUNTIMES: RefCell<RuntimeHandleTable> = RefCell::new(RuntimeHandleTable::default());
    static PLAN_RUNTIMES: RefCell<PlanRuntimeHandleTable> = RefCell::new(PlanRuntimeHandleTable::default());
}

#[derive(Default)]
struct RuntimeHandleTable {
    states: Vec<Option<RuntimeState>>,
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
    let plan = match executor::compile(&source) {
        Ok(plan) => plan,
        Err(diagnostics) => return compile_diagnostics(request_id, &diagnostics),
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
    let plan = match executor::admit(&bytes) {
        Ok(plan) => plan,
        Err(error) => return executor_error(request_id, message_type::ADMIT, error),
    };
    success_or_codec_error(request_id, message_type::ADMIT, encode_admitted_plan(&plan))
}

/// Re-admits and materializes a supervised plan into live logical processes.
/// The initial executor supports ordered emits and one registered investigator
/// or DKG query call per agent; every other expression fails closed.
#[wasm_bindgen]
#[must_use]
pub fn runtime_start_plan(input: &[u8]) -> Vec<u8> {
    let (request_id, bytes, logical_time) = match decode_start_plan_request(input) {
        Ok(decoded) => decoded,
        Err(error) => return codec_error(0, message_type::START_PLAN, error),
    };
    let state = match executor::start(&bytes, logical_time) {
        Ok(state) => state,
        Err(error) => return executor_error(request_id, message_type::START_PLAN, error),
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
            .ok_or(ExecutorError {
                code: "INVALID_PLAN_HANDLE",
                category: "execution",
            })?
            .advance(input)
    });
    match result {
        Ok(step) => {
            success_or_codec_error(request_id, message_type::APPLY_PLAN, encode_plan_step(step))
        }
        Err(error) => executor_error(request_id, message_type::APPLY_PLAN, error),
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

fn encode_plan_receipt(handle: u32, state: &PlanRuntime) -> Result<Vec<u8>, CodecError> {
    let receipt = state.inspect();
    encode_started_plan_receipt(
        handle,
        &receipt.canonical_hash,
        &receipt.strategy_ref,
        receipt.logical_time,
        &receipt.state_digest,
        &receipt.agents,
    )
}

fn encode_plan_inspection(state: &PlanRuntime) -> Result<Vec<u8>, CodecError> {
    let receipt = state.inspect();
    encode_started_plan_inspection(
        &receipt.canonical_hash,
        &receipt.strategy_ref,
        receipt.logical_time,
        &receipt.state_digest,
        &receipt.agents,
    )
}

fn encode_plan_step(step: PlanStep) -> Result<Vec<u8>, CodecError> {
    match step {
        PlanStep::EffectRequested(effect) => encode_plan_effect_request(
            effect.effect_id,
            &effect.process_id,
            &effect.operation,
            effect.version,
            &effect.arguments,
        ),
        PlanStep::Completed(completion) => {
            encode_plan_completed(&completion.events, &completion.outputs)
        }
    }
}

fn executor_error(request_id: u64, operation: u16, error: ExecutorError) -> Vec<u8> {
    encode_error(request_id, operation, error.code, error.category, false)
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
