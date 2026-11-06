//! WASI 0.3 Component Model boundary for the deterministic semantic kernel.
//!
//! The component exports typed WIT records, variants, results, and an opaque
//! execution resource. It calls the same typed executor as the wasm-bindgen
//! boundary, without internal CBOR envelopes or numeric handles.

#[allow(clippy::same_length_and_capacity)]
mod bindings {
    use super::Component;

    wit_bindgen::generate!({
        path: "wit",
        world: "semantic-runtime",
    });

    export!(Component);
}

use bindings::exports::origintrail::semantic_runtime::executor::{
    AdapterVersion, AdmissionDiagnostic, AdmittedPlan, Completion, Diagnostic, Execution,
    ExecutionReceipt, Guest, GuestExecution, LogicalAgent, PlanValue, ResourceBounds,
    SourcePosition, SourceSpan, Step,
};
use bindings::origintrail::semantic_runtime::capability::ExecutionCapability;
use bindings::origintrail::semantic_runtime::{
    asset_create, investigator, query_catalog, remote_execute, safe_llm, sparql_read,
};
use dkg_runtime_executor::{
    self as executor, ExecutorError, PlanEffectRequest, PlanReceipt, PlanRuntime, PlanStep,
};
use dkg_runtime_types::{ABI_VERSION, PlanApplyInput, SCHEMA_VERSION};
use std::cell::RefCell;

struct Component;

struct ExecutionState {
    runtime: RefCell<PlanRuntime>,
    capability: ExecutionCapability,
}

#[allow(clippy::unused_async_trait_impl)]
impl GuestExecution for ExecutionState {
    async fn advance(&self) -> Result<Step, Diagnostic> {
        let mut input = PlanApplyInput::Continue;
        loop {
            let step = self
                .runtime
                .borrow_mut()
                .advance(input)
                .map_err(executor_diagnostic)?;
            match step {
                PlanStep::EffectRequested(effect) => {
                    let effect_id = effect.effect_id;
                    let output = dispatch_tool(&self.capability, effect).await?;
                    input = PlanApplyInput::EffectResult {
                        effect_id,
                        result: Ok(output),
                    };
                }
                PlanStep::Completed(completion) => {
                    return Ok(Step::Completed(Completion {
                        events: completion.events.into_iter().map(plan_value).collect(),
                        outputs: completion.outputs.into_iter().map(plan_value).collect(),
                    }));
                }
            }
        }
    }

    fn inspect(&self) -> Result<ExecutionReceipt, Diagnostic> {
        Ok(execution_receipt(self.runtime.borrow().inspect()))
    }
}

impl Guest for Component {
    type Execution = ExecutionState;

    fn abi_version() -> u32 {
        u32::from(ABI_VERSION) << 16 | u32::from(SCHEMA_VERSION)
    }

    fn compile(source: String) -> Result<AdmittedPlan, Vec<AdmissionDiagnostic>> {
        executor::compile(source.as_bytes())
            .map(admitted_plan)
            .map_err(|diagnostics| diagnostics.into_iter().map(admission_diagnostic).collect())
    }

    fn admit(plan: Vec<u8>) -> Result<AdmittedPlan, Diagnostic> {
        executor::admit(&plan)
            .map(admitted_plan)
            .map_err(executor_diagnostic)
    }

    fn start(
        capability: ExecutionCapability,
        plan: Vec<u8>,
        logical_time: u64,
    ) -> Result<(Execution, ExecutionReceipt), Diagnostic> {
        let runtime = executor::start(&plan, logical_time).map_err(executor_diagnostic)?;
        let receipt = execution_receipt(runtime.inspect());
        Ok((
            Execution::new(ExecutionState {
                runtime: RefCell::new(runtime),
                capability,
            }),
            receipt,
        ))
    }
}

fn admitted_plan(plan: dkg_strategy_compiler::AdmittedPlan) -> AdmittedPlan {
    AdmittedPlan {
        canonical_plan: plan.canonical_plan_cbor,
        canonical_hash: plan.canonical_hash.to_vec(),
        strategy_ref: plan.strategy_ref,
        scope: plan.scope,
        goal: plan.goal,
        required_capabilities: plan.required_capabilities.into_iter().collect(),
        effect_upper_bound: plan
            .effect_upper_bound
            .into_iter()
            .map(|effect| effect.as_str().to_owned())
            .collect(),
        approval_requirements: plan
            .approval_requirements
            .into_iter()
            .map(|effect| effect.as_str().to_owned())
            .collect(),
        adapter_versions: plan
            .adapter_versions
            .into_iter()
            .map(|(operation, version)| AdapterVersion { operation, version })
            .collect(),
        bounds: ResourceBounds {
            processes: plan.resource_bounds.processes,
            host_commands: plan.resource_bounds.host_commands,
            retry_attempts: plan.resource_bounds.retry_attempts,
            depth: plan.resource_bounds.depth,
        },
    }
}

fn admission_diagnostic(value: dkg_ir::Diagnostic) -> AdmissionDiagnostic {
    let position = |value: dkg_ir::SourcePosition| SourcePosition {
        line: u64::try_from(value.line).expect("source line fits u64"),
        column: u64::try_from(value.column).expect("source column fits u64"),
    };
    AdmissionDiagnostic {
        code: value.code.as_str().into(),
        primary: SourceSpan {
            start: position(value.primary.start),
            end: position(value.primary.end),
        },
        message: value.message,
        help: value.help,
    }
}

fn execution_receipt(receipt: PlanReceipt) -> ExecutionReceipt {
    ExecutionReceipt {
        canonical_hash: receipt.canonical_hash.to_vec(),
        strategy_ref: receipt.strategy_ref,
        logical_time: receipt.logical_time,
        state_digest: receipt.state_digest.to_vec(),
        agents: receipt
            .agents
            .into_iter()
            .map(|agent| LogicalAgent {
                role: agent.role,
                process_id: agent.process_id.to_vec(),
                status: agent.status.into(),
            })
            .collect(),
    }
}

fn plan_value(value: dkg_runtime_types::PlanValue) -> PlanValue {
    PlanValue {
        role: value.role,
        process_id: value.process_id.to_vec(),
        value: value.value,
    }
}

fn executor_diagnostic(error: ExecutorError) -> Diagnostic {
    Diagnostic {
        code: error.code.into(),
        message: "semantic kernel rejected the operation".into(),
        category: error.category.into(),
        retryable: false,
    }
}

async fn dispatch_tool(
    capability: &ExecutionCapability,
    effect: PlanEffectRequest,
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
        "llm/safe" => {
            let prompt = only_text_argument(effect.arguments, "INVALID_SAFE_LLM_ARGUMENT")?;
            safe_llm::run(
                capability,
                safe_llm::Request {
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
        "dkg/sparql-read" => {
            let sparql = only_text_argument(effect.arguments, "INVALID_SPARQL_ARGUMENT")?;
            sparql_read::query(
                capability,
                sparql_read::Request {
                    effect_id: effect.effect_id,
                    sparql,
                },
            )
            .await
            .map_err(|error| tool_diagnostic(error.code, error.message, error.retryable))
        }
        "dkg/asset-create" => {
            let content_json = only_text_argument(effect.arguments, "INVALID_ASSET_ARGUMENT")?;
            asset_create::create(
                capability,
                asset_create::Request {
                    effect_id: effect.effect_id,
                    content_json,
                },
            )
            .await
            .map_err(|error| tool_diagnostic(error.code, error.message, error.retryable))
        }
        "remote-execute" => {
            let [node_id, program_iri] =
                text_arguments::<2>(effect.arguments, "INVALID_REMOTE_EXECUTE_ARGUMENT")?;
            remote_execute::execute(
                capability,
                remote_execute::Request {
                    effect_id: effect.effect_id,
                    node_id,
                    program_iri,
                },
            )
            .await
            .map(|result| result.execution_iri)
            .map_err(|error| tool_diagnostic(error.code, error.message, error.retryable))
        }
        _ => Err(diagnostic("COMPONENT_TOOL_NOT_IMPORTED", "tool")),
    }
}

fn only_text_argument(arguments: Vec<String>, code: &str) -> Result<String, Diagnostic> {
    text_arguments::<1>(arguments, code).map(|[value]| value)
}

fn text_arguments<const N: usize>(
    arguments: Vec<String>,
    code: &str,
) -> Result<[String; N], Diagnostic> {
    let values: [String; N] = arguments.try_into().map_err(|_| diagnostic(code, "tool"))?;
    values
        .map(|value| {
            value
                .strip_prefix("t:")
                .or_else(|| value.strip_prefix("s:"))
                .map(ToOwned::to_owned)
                .ok_or_else(|| diagnostic(code, "tool"))
        })
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .try_into()
        .map_err(|_| diagnostic(code, "tool"))
}

fn tool_diagnostic(code: String, message: String, retryable: bool) -> Diagnostic {
    Diagnostic {
        code,
        message,
        category: "tool".into(),
        retryable,
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
