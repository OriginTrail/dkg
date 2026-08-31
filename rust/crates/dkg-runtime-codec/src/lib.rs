//! Deterministic, bounded RFC 8949 CBOR envelopes for the Phase 0 ABI.

use std::collections::BTreeSet;

use dkg_ir::Diagnostic;
use dkg_runtime_kernel::{RuntimeError, RuntimeState, StepOutput};
use dkg_runtime_types::{
    ABI_VERSION, LogicalTime, RuntimeConfig, RuntimeEvent, RuntimeEventId, RuntimePartitionId,
    SCHEMA_VERSION,
};
use dkg_strategy_compiler::AdmittedPlan;
use dkg_trace_model::{TraceEvent, TraceKind};
use minicbor::{Decoder, Encoder, data::Type, decode, encode};

/// Maximum encoded request admitted by the Phase 0 Wasm boundary.
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// Maximum encoded snapshot admitted by the Phase 0 Wasm boundary.
pub const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum canonical plan bytes admitted by an execution Worker.
pub const MAX_PLAN_BYTES: usize = 4 * 1024 * 1024;

/// Stable message identifiers in ABI envelopes.
pub mod message_type {
    /// Create a new runtime handle.
    pub const CREATE: u16 = 1;
    /// Apply one deterministic event.
    pub const APPLY: u16 = 2;
    /// Snapshot one runtime handle.
    pub const SNAPSHOT: u16 = 3;
    /// Restore a new runtime handle.
    pub const RESTORE: u16 = 4;
    /// Inspect redaction-safe runtime state.
    pub const INSPECT: u16 = 5;
    /// Drop a runtime handle.
    pub const DROP: u16 = 6;
    /// Compile bounded declarative strategy source.
    pub const COMPILE: u16 = 7;
    /// Re-admit immutable canonical plan bytes.
    pub const ADMIT: u16 = 8;
    /// Materialize one narrowly executable admitted plan.
    pub const START_PLAN: u16 = 9;
    /// Inspect one materialized supervised plan.
    pub const INSPECT_PLAN: u16 = 10;
    /// Drop one materialized supervised plan.
    pub const DROP_PLAN: u16 = 11;
    /// Drive one materialized plan until completion or a host-effect boundary.
    pub const APPLY_PLAN: u16 = 12;
}

/// One value produced by a logical agent during plan execution.
pub struct PlanValue {
    /// Declared delegate role.
    pub role: String,
    /// Stable logical process identity.
    pub process_id: [u8; 32],
    /// Emitted value or external operation result.
    pub value: String,
}

/// Optional host result supplied while driving a plan.
pub enum PlanApplyInput {
    /// Continue deterministic execution without supplying an external result.
    Continue,
    /// Result for the single currently pending external operation.
    EffectResult {
        /// Stable request identity generated inside Wasm.
        effect_id: u64,
        /// Successful value or redaction-safe failure code.
        result: Result<String, String>,
    },
}

/// Redaction-safe identity and lifecycle state for one materialized logical agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartedAgentSummary {
    /// Stable role declared by the admitted `delegate` form.
    pub role: String,
    /// Deterministic process identity derived from the canonical plan.
    pub process_id: [u8; 32],
    /// Stable lifecycle state name.
    pub status: &'static str,
}

/// Successful ABI response payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AbiSuccess {
    /// Correlated request identity.
    pub request_id: u64,
    /// Operation message type.
    pub message_type: u16,
    /// Operation-specific deterministic CBOR bytes.
    pub payload: Vec<u8>,
}

/// Codec-level failures with stable codes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodecError {
    /// Request exceeded its hard boundary.
    RequestTooLarge,
    /// CBOR was malformed or contained an unsupported representation.
    Malformed,
    /// Envelope field count or version did not match.
    EnvelopeMismatch,
    /// Message type was not valid for the called export.
    MessageTypeMismatch,
    /// A 32-byte identifier had the wrong length.
    IdentifierLength,
    /// Input contained trailing bytes.
    TrailingData,
    /// Snapshot exceeded its hard boundary.
    SnapshotTooLarge,
    /// Canonical plan exceeded its hard boundary.
    PlanTooLarge,
}

impl CodecError {
    /// Stable ABI error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::RequestTooLarge => "ABI_REQUEST_TOO_LARGE",
            Self::Malformed => "ABI_MALFORMED_CBOR",
            Self::EnvelopeMismatch => "ABI_ENVELOPE_MISMATCH",
            Self::MessageTypeMismatch => "ABI_MESSAGE_TYPE_MISMATCH",
            Self::IdentifierLength => "ABI_IDENTIFIER_LENGTH",
            Self::TrailingData => "ABI_TRAILING_DATA",
            Self::SnapshotTooLarge => "SNAPSHOT_TOO_LARGE",
            Self::PlanTooLarge => "PLAN_TOO_LARGE",
        }
    }
}

impl From<decode::Error> for CodecError {
    fn from(_: decode::Error) -> Self {
        Self::Malformed
    }
}

impl From<encode::Error<std::convert::Infallible>> for CodecError {
    fn from(_: encode::Error<std::convert::Infallible>) -> Self {
        Self::Malformed
    }
}

/// Encodes a create request.
#[must_use]
pub fn encode_create_request(request_id: u64, config: &RuntimeConfig) -> Vec<u8> {
    let payload = encode_config(config).expect("Vec writer is infallible");
    encode_request(request_id, message_type::CREATE, &payload).expect("Vec writer is infallible")
}

/// Decodes and validates a create request.
pub fn decode_create_request(input: &[u8]) -> Result<(u64, RuntimeConfig), CodecError> {
    let envelope = decode_request(input, message_type::CREATE, MAX_REQUEST_BYTES)?;
    Ok((envelope.request_id, decode_config(&envelope.payload)?))
}

/// Encodes an event request.
#[must_use]
pub fn encode_event_request(request_id: u64, event: &RuntimeEvent) -> Vec<u8> {
    let payload = encode_event(event).expect("Vec writer is infallible");
    encode_request(request_id, message_type::APPLY, &payload).expect("Vec writer is infallible")
}

/// Decodes and validates an event request.
pub fn decode_event_request(input: &[u8]) -> Result<(u64, RuntimeEvent), CodecError> {
    let envelope = decode_request(input, message_type::APPLY, MAX_REQUEST_BYTES)?;
    Ok((envelope.request_id, decode_event(&envelope.payload)?))
}

/// Encodes declarative strategy source for compilation.
#[must_use]
pub fn encode_compile_request(request_id: u64, source: &[u8]) -> Vec<u8> {
    encode_request(request_id, message_type::COMPILE, source).expect("Vec writer is infallible")
}

/// Decodes bounded source bytes without interpreting or evaluating them.
pub fn decode_compile_request(input: &[u8]) -> Result<(u64, Vec<u8>), CodecError> {
    let envelope = decode_request(input, message_type::COMPILE, MAX_REQUEST_BYTES)?;
    Ok((envelope.request_id, envelope.payload))
}

/// Encodes canonical plan bytes for execution-partition admission.
#[must_use]
pub fn encode_admit_request(request_id: u64, plan: &[u8]) -> Vec<u8> {
    encode_request(request_id, message_type::ADMIT, plan).expect("Vec writer is infallible")
}

/// Decodes bounded canonical plan bytes without trusting their contents.
pub fn decode_admit_request(input: &[u8]) -> Result<(u64, Vec<u8>), CodecError> {
    let envelope = decode_request(input, message_type::ADMIT, MAX_PLAN_BYTES)?;
    if envelope.payload.len() > MAX_PLAN_BYTES {
        return Err(CodecError::PlanTooLarge);
    }
    Ok((envelope.request_id, envelope.payload))
}

/// Encodes a canonical plan plus explicit logical start time for materialization.
#[must_use]
pub fn encode_start_plan_request(request_id: u64, plan: &[u8], logical_time: u64) -> Vec<u8> {
    let mut payload = Encoder::new(Vec::new());
    payload.array(2).expect("Vec writer is infallible");
    payload.bytes(plan).expect("Vec writer is infallible");
    payload.u64(logical_time).expect("Vec writer is infallible");
    encode_request(request_id, message_type::START_PLAN, &payload.into_writer())
        .expect("Vec writer is infallible")
}

/// Decodes a bounded canonical plan and logical start time.
pub fn decode_start_plan_request(input: &[u8]) -> Result<(u64, Vec<u8>, u64), CodecError> {
    let envelope = decode_request(input, message_type::START_PLAN, MAX_PLAN_BYTES)?;
    let mut decoder = Decoder::new(&envelope.payload);
    require_array(&mut decoder, 2)?;
    let plan = decoder.bytes()?.to_vec();
    if plan.len() > MAX_PLAN_BYTES {
        return Err(CodecError::PlanTooLarge);
    }
    let logical_time = decoder.u64()?;
    require_finished(&decoder, envelope.payload.len())?;
    Ok((envelope.request_id, plan, logical_time))
}

/// Decodes either a plain drive request or one external-effect result.
pub fn decode_apply_plan_request(input: &[u8]) -> Result<(u64, PlanApplyInput), CodecError> {
    let envelope = decode_request(input, message_type::APPLY_PLAN, MAX_REQUEST_BYTES)?;
    let mut decoder = Decoder::new(&envelope.payload);
    let fields = require_definite_array(&mut decoder)?;
    let input = match (fields, decoder.u8()?) {
        (1, 0) => PlanApplyInput::Continue,
        (4, 1) => {
            let effect_id = decoder.u64()?;
            let ok = decoder.bool()?;
            let value = decoder.str()?.to_owned();
            PlanApplyInput::EffectResult {
                effect_id,
                result: if ok { Ok(value) } else { Err(value) },
            }
        }
        _ => return Err(CodecError::Malformed),
    };
    require_finished(&decoder, envelope.payload.len())?;
    Ok((envelope.request_id, input))
}

/// Encodes the next external operation selected by the Wasm executor.
pub fn encode_plan_effect_request(
    effect_id: u64,
    process_id: &[u8; 32],
    operation: &str,
    version: u16,
    arguments: &[String],
) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(6)?.u8(0)?.u64(effect_id)?.bytes(process_id)?;
    encoder.str(operation)?.u16(version)?;
    encoder.array(u64::try_from(arguments.len()).map_err(|_| CodecError::Malformed)?)?;
    for argument in arguments {
        encoder.str(argument)?;
    }
    Ok(encoder.into_writer())
}

/// Encodes the terminal values retained by the Wasm executor.
pub fn encode_plan_completed(
    events: &[PlanValue],
    outputs: &[PlanValue],
) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(3)?.u8(1)?;
    for values in [events, outputs] {
        encoder.array(u64::try_from(values.len()).map_err(|_| CodecError::Malformed)?)?;
        for value in values {
            encoder
                .array(3)?
                .str(&value.role)?
                .bytes(&value.process_id)?
                .str(&value.value)?;
        }
    }
    Ok(encoder.into_writer())
}

/// Encodes the first inspection receipt returned when a plan is materialized.
pub fn encode_started_plan_receipt(
    handle: u32,
    canonical_hash: &[u8; 32],
    strategy_ref: &str,
    logical_time: u64,
    state_digest: &[u8; 32],
    agents: &[StartedAgentSummary],
) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(6)?;
    encoder.u32(handle)?;
    encode_started_plan_fields(
        &mut encoder,
        canonical_hash,
        strategy_ref,
        logical_time,
        state_digest,
        agents,
    )?;
    Ok(encoder.into_writer())
}

/// Encodes a redaction-safe inspection of a materialized plan.
pub fn encode_started_plan_inspection(
    canonical_hash: &[u8; 32],
    strategy_ref: &str,
    logical_time: u64,
    state_digest: &[u8; 32],
    agents: &[StartedAgentSummary],
) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(5)?;
    encode_started_plan_fields(
        &mut encoder,
        canonical_hash,
        strategy_ref,
        logical_time,
        state_digest,
        agents,
    )?;
    Ok(encoder.into_writer())
}

fn encode_started_plan_fields(
    encoder: &mut Encoder<Vec<u8>>,
    canonical_hash: &[u8; 32],
    strategy_ref: &str,
    logical_time: u64,
    state_digest: &[u8; 32],
    agents: &[StartedAgentSummary],
) -> Result<(), CodecError> {
    encoder.bytes(canonical_hash)?;
    encoder.str(strategy_ref)?;
    encoder.u64(logical_time)?;
    encoder.bytes(state_digest)?;
    encoder.array(u64::try_from(agents.len()).map_err(|_| CodecError::Malformed)?)?;
    for agent in agents {
        encoder.array(3)?;
        encoder.str(&agent.role)?;
        encoder.bytes(&agent.process_id)?;
        encoder.str(agent.status)?;
    }
    Ok(())
}

/// Encodes an admitted plan summary returned by both compile and re-admit.
pub fn encode_admitted_plan(plan: &AdmittedPlan) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(10)?;
    encoder.bytes(&plan.canonical_plan_cbor)?;
    encoder.bytes(&plan.canonical_hash)?;
    encoder.str(&plan.strategy_ref)?;
    encoder.str(&plan.scope)?;
    encoder.str(&plan.goal)?;
    encoder.array(
        u64::try_from(plan.required_capabilities.len()).map_err(|_| CodecError::Malformed)?,
    )?;
    for capability in &plan.required_capabilities {
        encoder.str(capability)?;
    }
    encoder
        .array(u64::try_from(plan.effect_upper_bound.len()).map_err(|_| CodecError::Malformed)?)?;
    for effect in &plan.effect_upper_bound {
        encoder.str(effect.as_str())?;
    }
    encoder.array(
        u64::try_from(plan.approval_requirements.len()).map_err(|_| CodecError::Malformed)?,
    )?;
    for approval in &plan.approval_requirements {
        encoder.str(approval.as_str())?;
    }
    encoder.map(u64::try_from(plan.adapter_versions.len()).map_err(|_| CodecError::Malformed)?)?;
    for (adapter, version) in &plan.adapter_versions {
        encoder.str(adapter)?;
        encoder.u16(*version)?;
    }
    encoder.array(4)?;
    encoder.u32(plan.resource_bounds.processes)?;
    encoder.u32(plan.resource_bounds.host_commands)?;
    encoder.u32(plan.resource_bounds.retry_attempts)?;
    encoder.u16(plan.resource_bounds.depth)?;
    Ok(encoder.into_writer())
}

/// Encodes stable source diagnostics as an expected compile outcome.
pub fn encode_admission_diagnostics(diagnostics: &[Diagnostic]) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(u64::try_from(diagnostics.len()).map_err(|_| CodecError::Malformed)?)?;
    for diagnostic in diagnostics {
        encoder.array(7)?;
        encoder.str(diagnostic.code.as_str())?;
        encoder.u64(
            u64::try_from(diagnostic.primary.start.line).map_err(|_| CodecError::Malformed)?,
        )?;
        encoder.u64(
            u64::try_from(diagnostic.primary.start.column).map_err(|_| CodecError::Malformed)?,
        )?;
        encoder
            .u64(u64::try_from(diagnostic.primary.end.line).map_err(|_| CodecError::Malformed)?)?;
        encoder.u64(
            u64::try_from(diagnostic.primary.end.column).map_err(|_| CodecError::Malformed)?,
        )?;
        encoder.str(&diagnostic.message)?;
        match &diagnostic.help {
            Some(help) => encoder.str(help)?,
            None => encoder.null()?,
        };
    }
    Ok(encoder.into_writer())
}

/// Encodes a successful compilation outcome containing an admitted summary.
pub fn encode_compile_success(plan: &AdmittedPlan) -> Result<Vec<u8>, CodecError> {
    let admitted = encode_admitted_plan(plan)?;
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(2)?.u8(0)?.bytes(&admitted)?;
    Ok(encoder.into_writer())
}

/// Encodes rejected source as diagnostics without turning expected admission
/// failure into a Worker or Wasm fault.
pub fn encode_compile_diagnostics(diagnostics: &[Diagnostic]) -> Result<Vec<u8>, CodecError> {
    let diagnostics = encode_admission_diagnostics(diagnostics)?;
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(2)?.u8(1)?.bytes(&diagnostics)?;
    Ok(encoder.into_writer())
}

/// Encodes an empty operation request.
#[must_use]
pub fn encode_empty_request(request_id: u64, operation: u16) -> Vec<u8> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(0).expect("Vec writer is infallible");
    encode_request(request_id, operation, &encoder.into_writer()).expect("Vec writer is infallible")
}

/// Decodes an empty operation request.
pub fn decode_empty_request(input: &[u8], expected_message_type: u16) -> Result<u64, CodecError> {
    let envelope = decode_request(input, expected_message_type, MAX_REQUEST_BYTES)?;
    let mut decoder = Decoder::new(&envelope.payload);
    require_array(&mut decoder, 0)?;
    require_finished(&decoder, envelope.payload.len())?;
    Ok(envelope.request_id)
}

/// Encodes raw snapshot bytes into a restore request.
#[must_use]
pub fn encode_restore_request(request_id: u64, snapshot: &[u8]) -> Vec<u8> {
    encode_request(request_id, message_type::RESTORE, snapshot).expect("Vec writer is infallible")
}

/// Decodes a restore request without decoding snapshot state yet.
pub fn decode_restore_request(input: &[u8]) -> Result<(u64, Vec<u8>), CodecError> {
    let envelope = decode_request(input, message_type::RESTORE, MAX_SNAPSHOT_BYTES)?;
    if envelope.payload.len() > MAX_SNAPSHOT_BYTES {
        return Err(CodecError::SnapshotTooLarge);
    }
    Ok((envelope.request_id, envelope.payload))
}

/// Encodes one step output as operation-specific payload bytes.
pub fn encode_step_output(output: &StepOutput) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(6)?;
    encoder.u32(output.applied_events)?;
    encoder.u64(output.accumulator)?;
    encode_optional_time(&mut encoder, output.next_deadline)?;
    encoder.bytes(&output.state_digest)?;
    encoder.array(u64::try_from(output.trace_events.len()).map_err(|_| CodecError::Malformed)?)?;
    for trace in &output.trace_events {
        encode_trace(&mut encoder, trace)?;
    }
    encoder.bool(output.yielded)?;
    Ok(encoder.into_writer())
}

/// Encodes a complete snapshot.
pub fn encode_snapshot(state: &RuntimeState) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(9)?;
    encoder.u16(SCHEMA_VERSION)?;
    encoder.bytes(&state.partition_id().bytes())?;
    encoder.u32(state.config().max_events)?;
    encoder.u64(state.config().max_accumulator)?;
    encoder.u32(state.applied_events())?;
    encoder.u64(state.accumulator())?;
    encoder.u64(state.last_logical_time().0)?;
    encode_optional_time(&mut encoder, state.next_deadline())?;
    encoder.array(u64::from(state.applied_events()))?;
    for event_id in state.seen_event_ids() {
        encoder.bytes(&event_id.bytes())?;
    }
    let bytes = encoder.into_writer();
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(CodecError::SnapshotTooLarge);
    }
    Ok(bytes)
}

/// Decodes and validates a complete snapshot.
pub fn decode_snapshot(input: &[u8]) -> Result<RuntimeState, CodecError> {
    if input.len() > MAX_SNAPSHOT_BYTES {
        return Err(CodecError::SnapshotTooLarge);
    }
    let mut decoder = Decoder::new(input);
    require_array(&mut decoder, 9)?;
    if decoder.u16()? != SCHEMA_VERSION {
        return Err(CodecError::EnvelopeMismatch);
    }
    let partition_id = RuntimePartitionId::new(decode_id(&mut decoder)?);
    let max_events = decoder.u32()?;
    let max_accumulator = decoder.u64()?;
    let applied_events = decoder.u32()?;
    let accumulator = decoder.u64()?;
    let last_logical_time = LogicalTime(decoder.u64()?);
    let next_deadline = decode_optional_time(&mut decoder)?;
    let event_count = require_definite_array(&mut decoder)?;
    if event_count != u64::from(applied_events) {
        return Err(CodecError::Malformed);
    }
    let mut seen_event_ids = BTreeSet::new();
    for _ in 0..event_count {
        if !seen_event_ids.insert(RuntimeEventId::new(decode_id(&mut decoder)?)) {
            return Err(CodecError::Malformed);
        }
    }
    require_finished(&decoder, input.len())?;
    RuntimeState::restore(
        RuntimeConfig {
            partition_id,
            max_events,
            max_accumulator,
        },
        applied_events,
        accumulator,
        last_logical_time,
        next_deadline,
        seen_event_ids,
    )
    .map_err(|_| CodecError::Malformed)
}

/// Encodes redaction-safe inspection state.
pub fn encode_inspection(state: &RuntimeState) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(5)?;
    encoder.u32(state.applied_events())?;
    encoder.u64(state.accumulator())?;
    encoder.u64(state.last_logical_time().0)?;
    encode_optional_time(&mut encoder, state.next_deadline())?;
    encoder.bytes(&state.state_digest())?;
    Ok(encoder.into_writer())
}

/// Encodes a numeric runtime handle.
pub fn encode_handle(handle: u32) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(1)?.u32(handle)?;
    Ok(encoder.into_writer())
}

/// Encodes a boolean status payload.
pub fn encode_status(status: bool) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(1)?.bool(status)?;
    Ok(encoder.into_writer())
}

/// Encodes a successful ABI envelope.
#[must_use]
pub fn encode_success(request_id: u64, operation: u16, payload: &[u8]) -> Vec<u8> {
    let mut result = Encoder::new(Vec::new());
    result.array(2).expect("Vec writer is infallible");
    result.u8(0).expect("Vec writer is infallible");
    result.bytes(payload).expect("Vec writer is infallible");
    encode_envelope(request_id, operation, &result.into_writer()).expect("Vec writer is infallible")
}

/// Encodes a stable error ABI envelope.
#[must_use]
pub fn encode_error(
    request_id: u64,
    operation: u16,
    code: &str,
    category: &str,
    retryable: bool,
) -> Vec<u8> {
    let mut result = Encoder::new(Vec::new());
    result.array(4).expect("Vec writer is infallible");
    result.u8(1).expect("Vec writer is infallible");
    result.str(code).expect("Vec writer is infallible");
    result.str(category).expect("Vec writer is infallible");
    result.bool(retryable).expect("Vec writer is infallible");
    encode_envelope(request_id, operation, &result.into_writer()).expect("Vec writer is infallible")
}

/// Encodes a kernel error using its stable code and category.
#[must_use]
pub fn encode_runtime_error(request_id: u64, operation: u16, error: RuntimeError) -> Vec<u8> {
    encode_error(request_id, operation, error.code(), error.category(), false)
}

/// Decodes a successful envelope for native conformance tests.
pub fn decode_success(input: &[u8], expected_message_type: u16) -> Result<AbiSuccess, CodecError> {
    let envelope = decode_envelope(input, MAX_SNAPSHOT_BYTES)?;
    if envelope.message_type != expected_message_type {
        return Err(CodecError::MessageTypeMismatch);
    }
    let mut decoder = Decoder::new(&envelope.payload);
    require_array(&mut decoder, 2)?;
    if decoder.u8()? != 0 {
        return Err(CodecError::Malformed);
    }
    let payload = decoder.bytes()?.to_vec();
    require_finished(&decoder, envelope.payload.len())?;
    Ok(AbiSuccess {
        request_id: envelope.request_id,
        message_type: envelope.message_type,
        payload,
    })
}

struct Envelope {
    request_id: u64,
    message_type: u16,
    payload: Vec<u8>,
}

fn encode_request(request_id: u64, operation: u16, payload: &[u8]) -> Result<Vec<u8>, CodecError> {
    encode_envelope(request_id, operation, payload)
}

fn encode_envelope(request_id: u64, operation: u16, payload: &[u8]) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(5)?;
    encoder.u16(ABI_VERSION)?;
    encoder.u16(SCHEMA_VERSION)?;
    encoder.u64(request_id)?;
    encoder.u16(operation)?;
    encoder.bytes(payload)?;
    Ok(encoder.into_writer())
}

fn decode_request(
    input: &[u8],
    expected_message_type: u16,
    max_bytes: usize,
) -> Result<Envelope, CodecError> {
    let envelope = decode_envelope(input, max_bytes)?;
    if envelope.message_type != expected_message_type {
        return Err(CodecError::MessageTypeMismatch);
    }
    Ok(envelope)
}

fn decode_envelope(input: &[u8], max_bytes: usize) -> Result<Envelope, CodecError> {
    if input.len() > max_bytes {
        return Err(CodecError::RequestTooLarge);
    }
    let mut decoder = Decoder::new(input);
    require_array(&mut decoder, 5)?;
    if decoder.u16()? != ABI_VERSION || decoder.u16()? != SCHEMA_VERSION {
        return Err(CodecError::EnvelopeMismatch);
    }
    let request_id = decoder.u64()?;
    let message_type = decoder.u16()?;
    let payload = decoder.bytes()?.to_vec();
    require_finished(&decoder, input.len())?;
    Ok(Envelope {
        request_id,
        message_type,
        payload,
    })
}

fn encode_config(config: &RuntimeConfig) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(3)?;
    encoder.bytes(&config.partition_id.bytes())?;
    encoder.u32(config.max_events)?;
    encoder.u64(config.max_accumulator)?;
    Ok(encoder.into_writer())
}

fn decode_config(input: &[u8]) -> Result<RuntimeConfig, CodecError> {
    let mut decoder = Decoder::new(input);
    require_array(&mut decoder, 3)?;
    let config = RuntimeConfig {
        partition_id: RuntimePartitionId::new(decode_id(&mut decoder)?),
        max_events: decoder.u32()?,
        max_accumulator: decoder.u64()?,
    };
    require_finished(&decoder, input.len())?;
    Ok(config)
}

fn encode_event(event: &RuntimeEvent) -> Result<Vec<u8>, CodecError> {
    let mut encoder = Encoder::new(Vec::new());
    encoder.array(4)?;
    match event {
        RuntimeEvent::Advance {
            event_id,
            logical_time,
            delta,
        } => {
            encoder.u8(0)?;
            encoder.bytes(&event_id.bytes())?;
            encoder.u64(logical_time.0)?;
            encoder.u64(*delta)?;
        }
        RuntimeEvent::SetDeadline {
            event_id,
            logical_time,
            deadline,
        } => {
            encoder.u8(1)?;
            encoder.bytes(&event_id.bytes())?;
            encoder.u64(logical_time.0)?;
            encode_optional_time(&mut encoder, *deadline)?;
        }
    }
    Ok(encoder.into_writer())
}

fn decode_event(input: &[u8]) -> Result<RuntimeEvent, CodecError> {
    let mut decoder = Decoder::new(input);
    require_array(&mut decoder, 4)?;
    let kind = decoder.u8()?;
    let event_id = RuntimeEventId::new(decode_id(&mut decoder)?);
    let logical_time = LogicalTime(decoder.u64()?);
    let event = match kind {
        0 => RuntimeEvent::Advance {
            event_id,
            logical_time,
            delta: decoder.u64()?,
        },
        1 => RuntimeEvent::SetDeadline {
            event_id,
            logical_time,
            deadline: decode_optional_time(&mut decoder)?,
        },
        _ => return Err(CodecError::Malformed),
    };
    require_finished(&decoder, input.len())?;
    Ok(event)
}

fn encode_trace(encoder: &mut Encoder<Vec<u8>>, trace: &TraceEvent) -> Result<(), CodecError> {
    encoder.array(4)?;
    encoder.bytes(&trace.event_id.bytes())?;
    encoder.u64(trace.logical_time.0)?;
    encoder.u8(match trace.kind {
        TraceKind::AccumulatorAdvanced => 0,
        TraceKind::DeadlineChanged => 1,
        TraceKind::DuplicateIgnored => 2,
    })?;
    encoder.u64(trace.value)?;
    Ok(())
}

fn encode_optional_time(
    encoder: &mut Encoder<Vec<u8>>,
    value: Option<LogicalTime>,
) -> Result<(), CodecError> {
    match value {
        Some(value) => {
            encoder.u64(value.0)?;
        }
        None => {
            encoder.null()?;
        }
    }
    Ok(())
}

fn decode_optional_time(decoder: &mut Decoder<'_>) -> Result<Option<LogicalTime>, CodecError> {
    if decoder.datatype()? == Type::Null {
        decoder.null()?;
        Ok(None)
    } else {
        Ok(Some(LogicalTime(decoder.u64()?)))
    }
}

fn decode_id(decoder: &mut Decoder<'_>) -> Result<[u8; 32], CodecError> {
    let bytes = decoder.bytes()?;
    bytes.try_into().map_err(|_| CodecError::IdentifierLength)
}

fn require_array(decoder: &mut Decoder<'_>, expected: u64) -> Result<(), CodecError> {
    if require_definite_array(decoder)? == expected {
        Ok(())
    } else {
        Err(CodecError::Malformed)
    }
}

fn require_definite_array(decoder: &mut Decoder<'_>) -> Result<u64, CodecError> {
    decoder.array()?.ok_or(CodecError::Malformed)
}

fn require_finished(decoder: &Decoder<'_>, input_len: usize) -> Result<(), CodecError> {
    if decoder.position() == input_len {
        Ok(())
    } else {
        Err(CodecError::TrailingData)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_and_snapshot_round_trip_without_indefinite_data() {
        let config = RuntimeConfig {
            partition_id: RuntimePartitionId::new([7; 32]),
            max_events: 8,
            max_accumulator: 1_000,
        };
        let request = encode_create_request(41, &config);
        assert_eq!(decode_create_request(&request), Ok((41, config.clone())));

        let mut state = RuntimeState::new(config).expect("state");
        state
            .apply_event(&RuntimeEvent::Advance {
                event_id: RuntimeEventId::new([8; 32]),
                logical_time: LogicalTime(11),
                delta: 9,
            })
            .expect("apply");
        let snapshot = encode_snapshot(&state).expect("snapshot");
        assert_eq!(decode_snapshot(&snapshot), Ok(state));
    }

    #[test]
    fn malformed_identifier_and_trailing_data_are_rejected() {
        let mut payload = Encoder::new(Vec::new());
        payload.array(3).unwrap();
        payload.bytes(&[1; 31]).unwrap();
        payload.u32(1).unwrap();
        payload.u64(1).unwrap();
        let input = encode_request(1, message_type::CREATE, &payload.into_writer()).unwrap();
        assert_eq!(
            decode_create_request(&input),
            Err(CodecError::IdentifierLength)
        );

        let mut valid = encode_empty_request(1, message_type::SNAPSHOT);
        valid.push(0);
        assert_eq!(
            decode_empty_request(&valid, message_type::SNAPSHOT),
            Err(CodecError::TrailingData)
        );
    }
}
