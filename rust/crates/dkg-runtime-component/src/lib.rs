//! WASI 0.3 Component Model boundary for the deterministic semantic kernel.
//!
//! The component exports typed WIT records, variants, results, and an opaque
//! execution resource. The existing CBOR codec is used only behind this
//! boundary to reuse the already-conformant deterministic kernel.

#[allow(clippy::same_length_and_capacity)]
mod bindings {
    use super::Component;

    wit_bindgen::generate!({
        path: "wit",
        world: "semantic-runtime",
    });

    export!(Component);
}

use bindings::exports::origintrail::semantic_runtime::runtime::{
    AdapterVersion, AdmissionDiagnostic, AdmittedPlan, Completion, Diagnostic, Execution,
    ExecutionReceipt, Guest, GuestExecution, LogicalAgent, PlanValue, ResourceBounds,
    SourcePosition, SourceSpan, Step,
};
use bindings::origintrail::semantic_runtime::capability::ExecutionCapability;
use bindings::origintrail::semantic_runtime::{investigator, query_catalog};
use dkg_runtime_codec::{
    AbiResponse, PlanApplyInput, decode_response, encode_admit_request, encode_apply_plan_request,
    encode_compile_request, encode_empty_request, encode_start_plan_request, message_type,
};
use dkg_runtime_types::{ABI_VERSION, SCHEMA_VERSION};
use minicbor::{Decoder, data::Type};

const REQUEST_ID: u64 = 1;

struct Component;

struct ExecutionState {
    handle: u32,
    capability: ExecutionCapability,
}

struct KernelEffectRequest {
    effect_id: u64,
    operation: String,
    version: u16,
    arguments: Vec<String>,
}

enum KernelStep {
    EffectRequested(KernelEffectRequest),
    Completed(Completion),
}

impl Drop for ExecutionState {
    fn drop(&mut self) {
        let request = encode_empty_request(REQUEST_ID, message_type::DROP_PLAN);
        let _ = dkg_runtime_wasm::runtime_drop_plan(self.handle, &request);
    }
}

#[allow(clippy::unused_async_trait_impl)]
impl GuestExecution for ExecutionState {
    async fn advance(&self) -> Result<Step, Diagnostic> {
        let mut input = PlanApplyInput::Continue;
        loop {
            let request = encode_apply_plan_request(REQUEST_ID, &input);
            let response = dkg_runtime_wasm::runtime_apply_plan(self.handle, &request);
            match decode_kernel_step(&success_payload(&response, message_type::APPLY_PLAN)?)? {
                KernelStep::EffectRequested(effect) => {
                    let effect_id = effect.effect_id;
                    let output = dispatch_tool(&self.capability, effect).await?;
                    input = PlanApplyInput::EffectResult {
                        effect_id,
                        result: Ok(output),
                    };
                }
                KernelStep::Completed(completion) => return Ok(Step::Completed(completion)),
            }
        }
    }

    fn inspect(&self) -> Result<ExecutionReceipt, Diagnostic> {
        let request = encode_empty_request(REQUEST_ID, message_type::INSPECT_PLAN);
        let response = dkg_runtime_wasm::runtime_inspect_plan(self.handle, &request);
        decode_receipt(
            &success_payload(&response, message_type::INSPECT_PLAN)?,
            false,
        )
        .map(|(_, receipt)| receipt)
    }
}

impl Guest for Component {
    type Execution = ExecutionState;

    fn abi_version() -> u32 {
        u32::from(ABI_VERSION) << 16 | u32::from(SCHEMA_VERSION)
    }

    fn compile(source: String) -> Result<AdmittedPlan, Vec<AdmissionDiagnostic>> {
        let request = encode_compile_request(REQUEST_ID, source.as_bytes());
        let response = dkg_runtime_wasm::runtime_compile_strategy(&request);
        let payload = success_payload(&response, message_type::COMPILE)
            .map_err(|error| vec![abi_admission_diagnostic(error)])?;
        decode_compile(&payload).map_err(|error| vec![abi_admission_diagnostic(error)])?
    }

    fn admit(plan: Vec<u8>) -> Result<AdmittedPlan, Diagnostic> {
        let request = encode_admit_request(REQUEST_ID, &plan);
        let response = dkg_runtime_wasm::runtime_admit_plan(&request);
        decode_admitted_plan(&success_payload(&response, message_type::ADMIT)?)
    }

    fn start(
        capability: ExecutionCapability,
        plan: Vec<u8>,
        logical_time: u64,
    ) -> Result<(Execution, ExecutionReceipt), Diagnostic> {
        let request = encode_start_plan_request(REQUEST_ID, &plan, logical_time);
        let response = dkg_runtime_wasm::runtime_start_plan(&request);
        let (handle, receipt) =
            decode_receipt(&success_payload(&response, message_type::START_PLAN)?, true)?;
        let handle = handle.ok_or_else(|| diagnostic("COMPONENT_HANDLE", "component"))?;
        Ok((
            Execution::new(ExecutionState { handle, capability }),
            receipt,
        ))
    }

    fn test_hang() {
        dkg_runtime_wasm::runtime_phase0_test_hang();
    }

    fn test_trap() {
        dkg_runtime_wasm::runtime_phase0_test_trap();
    }
}

fn success_payload(input: &[u8], operation: u16) -> Result<Vec<u8>, Diagnostic> {
    match decode_response(input, operation).map_err(|error| diagnostic(error.code(), "codec"))? {
        AbiResponse::Success(success) if success.request_id == REQUEST_ID => Ok(success.payload),
        AbiResponse::Success(_) => Err(diagnostic("REQUEST_ID_MISMATCH", "component")),
        AbiResponse::Failure(failure) => Err(Diagnostic {
            code: failure.code,
            message: "semantic kernel rejected the operation".into(),
            category: failure.category,
            retryable: failure.retryable,
        }),
    }
}

fn decode_compile(
    payload: &[u8],
) -> Result<Result<AdmittedPlan, Vec<AdmissionDiagnostic>>, Diagnostic> {
    let mut decoder = Decoder::new(payload);
    require_array(&mut decoder, 2)?;
    let tag = decoder.u8().map_err(decode_error)?;
    let body = decoder.bytes().map_err(decode_error)?;
    let result = match tag {
        0 => Ok(decode_admitted_plan(body)?),
        1 => Err(decode_admission_diagnostics(body)?),
        _ => return Err(diagnostic("COMPONENT_COMPILE_TAG", "codec")),
    };
    require_finished(&decoder, payload.len())?;
    Ok(result)
}

fn decode_admitted_plan(payload: &[u8]) -> Result<AdmittedPlan, Diagnostic> {
    let mut decoder = Decoder::new(payload);
    require_array(&mut decoder, 10)?;
    let canonical_plan = decoder.bytes().map_err(decode_error)?.to_vec();
    let canonical_hash = decoder.bytes().map_err(decode_error)?.to_vec();
    let strategy_ref = decoder.str().map_err(decode_error)?.to_owned();
    let scope = decoder.str().map_err(decode_error)?.to_owned();
    let goal = decoder.str().map_err(decode_error)?.to_owned();
    let required_capabilities = decode_strings(&mut decoder)?;
    let effect_upper_bound = decode_strings(&mut decoder)?;
    let approval_requirements = decode_strings(&mut decoder)?;
    let adapter_count = decoder
        .map()
        .map_err(decode_error)?
        .ok_or_else(|| diagnostic("COMPONENT_INDEFINITE_MAP", "codec"))?;
    let mut adapter_versions = Vec::with_capacity(to_usize(adapter_count)?);
    for _ in 0..adapter_count {
        adapter_versions.push(AdapterVersion {
            operation: decoder.str().map_err(decode_error)?.to_owned(),
            version: decoder.u16().map_err(decode_error)?,
        });
    }
    require_array(&mut decoder, 4)?;
    let bounds = ResourceBounds {
        processes: decoder.u32().map_err(decode_error)?,
        host_commands: decoder.u32().map_err(decode_error)?,
        retry_attempts: decoder.u32().map_err(decode_error)?,
        depth: decoder.u16().map_err(decode_error)?,
    };
    require_finished(&decoder, payload.len())?;
    Ok(AdmittedPlan {
        canonical_plan,
        canonical_hash,
        strategy_ref,
        scope,
        goal,
        required_capabilities,
        effect_upper_bound,
        approval_requirements,
        adapter_versions,
        bounds,
    })
}

fn decode_admission_diagnostics(payload: &[u8]) -> Result<Vec<AdmissionDiagnostic>, Diagnostic> {
    let mut decoder = Decoder::new(payload);
    let count = require_list(&mut decoder)?;
    let mut diagnostics = Vec::with_capacity(to_usize(count)?);
    for _ in 0..count {
        require_array(&mut decoder, 7)?;
        let code = decoder.str().map_err(decode_error)?.to_owned();
        let start = SourcePosition {
            line: decoder.u64().map_err(decode_error)?,
            column: decoder.u64().map_err(decode_error)?,
        };
        let end = SourcePosition {
            line: decoder.u64().map_err(decode_error)?,
            column: decoder.u64().map_err(decode_error)?,
        };
        let message = decoder.str().map_err(decode_error)?.to_owned();
        let help = if decoder.datatype().map_err(decode_error)? == Type::Null {
            decoder.null().map_err(decode_error)?;
            None
        } else {
            Some(decoder.str().map_err(decode_error)?.to_owned())
        };
        diagnostics.push(AdmissionDiagnostic {
            code,
            primary: SourceSpan { start, end },
            message,
            help,
        });
    }
    require_finished(&decoder, payload.len())?;
    Ok(diagnostics)
}

fn decode_receipt(
    payload: &[u8],
    includes_handle: bool,
) -> Result<(Option<u32>, ExecutionReceipt), Diagnostic> {
    let mut decoder = Decoder::new(payload);
    require_array(&mut decoder, if includes_handle { 6 } else { 5 })?;
    let handle = if includes_handle {
        Some(decoder.u32().map_err(decode_error)?)
    } else {
        None
    };
    let canonical_hash = decoder.bytes().map_err(decode_error)?.to_vec();
    let strategy_ref = decoder.str().map_err(decode_error)?.to_owned();
    let logical_time = decoder.u64().map_err(decode_error)?;
    let state_digest = decoder.bytes().map_err(decode_error)?.to_vec();
    let count = require_list(&mut decoder)?;
    let mut agents = Vec::with_capacity(to_usize(count)?);
    for _ in 0..count {
        require_array(&mut decoder, 3)?;
        agents.push(LogicalAgent {
            role: decoder.str().map_err(decode_error)?.to_owned(),
            process_id: decoder.bytes().map_err(decode_error)?.to_vec(),
            status: decoder.str().map_err(decode_error)?.to_owned(),
        });
    }
    require_finished(&decoder, payload.len())?;
    Ok((
        handle,
        ExecutionReceipt {
            canonical_hash,
            strategy_ref,
            logical_time,
            state_digest,
            agents,
        },
    ))
}

fn decode_kernel_step(payload: &[u8]) -> Result<KernelStep, Diagnostic> {
    let mut decoder = Decoder::new(payload);
    let length = decoder
        .array()
        .map_err(decode_error)?
        .ok_or_else(|| diagnostic("COMPONENT_INDEFINITE_ARRAY", "codec"))?;
    let tag = decoder.u8().map_err(decode_error)?;
    let step = match (tag, length) {
        (0, 6) => {
            let effect = KernelEffectRequest {
                effect_id: decoder.u64().map_err(decode_error)?,
                operation: {
                    let _process_id = decoder.bytes().map_err(decode_error)?;
                    decoder.str().map_err(decode_error)?.to_owned()
                },
                version: decoder.u16().map_err(decode_error)?,
                arguments: decode_strings(&mut decoder)?,
            };
            KernelStep::EffectRequested(effect)
        }
        (1, 3) => KernelStep::Completed(Completion {
            events: decode_plan_values(&mut decoder)?,
            outputs: decode_plan_values(&mut decoder)?,
        }),
        _ => return Err(diagnostic("COMPONENT_STEP_TAG", "codec")),
    };
    require_finished(&decoder, payload.len())?;
    Ok(step)
}

async fn dispatch_tool(
    capability: &ExecutionCapability,
    effect: KernelEffectRequest,
) -> Result<String, Diagnostic> {
    if effect.version != 1 {
        return Err(diagnostic("COMPONENT_TOOL_VERSION", "tool"));
    }
    match effect.operation.as_str() {
        "agent/investigate" => {
            let prompt = only_text_argument(effect.arguments, "INVALID_LLM_ARGUMENT")?;
            investigator::investigate(
                capability,
                investigator::Request {
                    effect_id: effect.effect_id,
                    prompt,
                },
            )
            .await
            .map_err(|error| tool_diagnostic(error.code, error.message, error.retryable))
        }
        "dkg/query" => {
            let query_id = only_text_argument(effect.arguments, "INVALID_QUERY_ARGUMENT")?;
            query_catalog::query(
                capability,
                query_catalog::Request {
                    effect_id: effect.effect_id,
                    query_id,
                    parameters: Vec::new(),
                },
            )
            .await
            .map(|result| result.json)
            .map_err(|error| tool_diagnostic(error.code, error.message, error.retryable))
        }
        _ => Err(diagnostic("COMPONENT_TOOL_NOT_IMPORTED", "tool")),
    }
}

fn only_text_argument(arguments: Vec<String>, code: &str) -> Result<String, Diagnostic> {
    let [value]: [String; 1] = arguments.try_into().map_err(|_| diagnostic(code, "tool"))?;
    value
        .strip_prefix("t:")
        .or_else(|| value.strip_prefix("s:"))
        .map(ToOwned::to_owned)
        .ok_or_else(|| diagnostic(code, "tool"))
}

fn tool_diagnostic(code: String, message: String, retryable: bool) -> Diagnostic {
    Diagnostic {
        code,
        message,
        category: "tool".into(),
        retryable,
    }
}

fn decode_plan_values(decoder: &mut Decoder<'_>) -> Result<Vec<PlanValue>, Diagnostic> {
    let count = require_list(decoder)?;
    let mut values = Vec::with_capacity(to_usize(count)?);
    for _ in 0..count {
        require_array(decoder, 3)?;
        values.push(PlanValue {
            role: decoder.str().map_err(decode_error)?.to_owned(),
            process_id: decoder.bytes().map_err(decode_error)?.to_vec(),
            value: decoder.str().map_err(decode_error)?.to_owned(),
        });
    }
    Ok(values)
}

fn decode_strings(decoder: &mut Decoder<'_>) -> Result<Vec<String>, Diagnostic> {
    let count = require_list(decoder)?;
    let mut values = Vec::with_capacity(to_usize(count)?);
    for _ in 0..count {
        values.push(decoder.str().map_err(decode_error)?.to_owned());
    }
    Ok(values)
}

fn require_array(decoder: &mut Decoder<'_>, expected: u64) -> Result<(), Diagnostic> {
    if decoder.array().map_err(decode_error)? != Some(expected) {
        return Err(diagnostic("COMPONENT_ARRAY_SHAPE", "codec"));
    }
    Ok(())
}

fn require_list(decoder: &mut Decoder<'_>) -> Result<u64, Diagnostic> {
    decoder
        .array()
        .map_err(decode_error)?
        .ok_or_else(|| diagnostic("COMPONENT_INDEFINITE_ARRAY", "codec"))
}

fn require_finished(decoder: &Decoder<'_>, length: usize) -> Result<(), Diagnostic> {
    if decoder.position() != length {
        return Err(diagnostic("COMPONENT_TRAILING_DATA", "codec"));
    }
    Ok(())
}

fn to_usize(value: u64) -> Result<usize, Diagnostic> {
    usize::try_from(value).map_err(|_| diagnostic("COMPONENT_LIMIT", "limit"))
}

#[allow(clippy::needless_pass_by_value)]
fn decode_error(error: minicbor::decode::Error) -> Diagnostic {
    Diagnostic {
        code: "COMPONENT_DECODE".into(),
        message: error.to_string(),
        category: "codec".into(),
        retryable: false,
    }
}

fn diagnostic(code: &str, category: &str) -> Diagnostic {
    Diagnostic {
        code: code.into(),
        message: "semantic component boundary rejected malformed kernel data".into(),
        category: category.into(),
        retryable: false,
    }
}

fn abi_admission_diagnostic(error: Diagnostic) -> AdmissionDiagnostic {
    AdmissionDiagnostic {
        code: error.code,
        primary: SourceSpan {
            start: SourcePosition { line: 1, column: 0 },
            end: SourcePosition { line: 1, column: 0 },
        },
        message: error.message,
        help: None,
    }
}
