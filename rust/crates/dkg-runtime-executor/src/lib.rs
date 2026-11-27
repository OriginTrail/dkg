//! Transport-independent typed strategy admission and supervised execution.

use dkg_ir::{AdmissionLimits, Diagnostic, parse_strategy_bytes};
use dkg_runtime_kernel::{
    BudgetKind, CapabilityRef, ChildSpec, ChildSpecId, MailboxSpec, OverflowPolicy, ProcessId,
    ProcessStatus, RestartClass, RestartStrategy, SupervisedKernel, TerminationReason,
};
use dkg_runtime_types::{PlanApplyInput, PlanValue, SCHEMA_VERSION, StartedAgentSummary};
use dkg_strategy_compiler::{
    AdapterRegistry, AdmittedPlan, EffectClass, PlanExpr, RegisteredCall, SupervisorStrategy,
    admit_canonical_plan, compile_strategy,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Stable execution failure, independent of any transport envelope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExecutorError {
    /// Machine-readable failure code.
    pub code: &'static str,
    /// Stable admission, materialization, or execution category.
    pub category: &'static str,
}

/// A suspended, deterministic host operation selected by the kernel.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanEffectRequest {
    /// Execution-local effect identity.
    pub effect_id: u64,
    /// Logical process which owns the effect and its budget.
    pub process_id: [u8; 32],
    /// Registered operation name.
    pub operation: String,
    /// Pinned operation version.
    pub version: u16,
    /// Validated operation arguments.
    pub arguments: Vec<String>,
}

/// Values retained after all logical agents have completed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanCompletion {
    /// Deterministic emitted values in execution order.
    pub events: Vec<PlanValue>,
    /// Successful host results in execution order.
    pub outputs: Vec<PlanValue>,
}

/// The next observable boundary of an execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanStep {
    /// A host effect must settle before the partition can continue.
    EffectRequested(PlanEffectRequest),
    /// All logical agents have completed.
    Completed(PlanCompletion),
}

/// Redaction-safe inspection of an execution partition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanReceipt {
    /// Hash of the re-admitted canonical plan.
    pub canonical_hash: [u8; 32],
    /// Strategy name and pinned version.
    pub strategy_ref: String,
    /// Current deterministic logical time.
    pub logical_time: u64,
    /// Supervised kernel state digest.
    pub state_digest: [u8; 32],
    /// Logical agent identities and lifecycle states.
    pub agents: Vec<StartedAgentSummary>,
}

/// Compile bounded source as data using the registered V1 adapters.
pub fn compile(source: &[u8]) -> Result<AdmittedPlan, Vec<Diagnostic>> {
    let ast = parse_strategy_bytes(source, AdmissionLimits::default())?;
    compile_strategy(&ast, &AdapterRegistry::v1())
}

/// Re-admit immutable plan bytes rather than trusting their hash alone.
pub fn admit(bytes: &[u8]) -> Result<AdmittedPlan, ExecutorError> {
    admit_canonical_plan(bytes, &AdapterRegistry::v1()).map_err(|error| ExecutorError {
        code: error.code(),
        category: "admission",
    })
}

/// Re-admit and materialize a plan into an independently owned partition.
pub fn start(bytes: &[u8], logical_time: u64) -> Result<PlanRuntime, ExecutorError> {
    materialize_plan(&admit(bytes)?, logical_time).map_err(|code| ExecutorError {
        code,
        category: "materialization",
    })
}

/// One execution partition, owned directly by each transport resource.
pub struct PlanRuntime {
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

impl PlanRuntime {
    /// Drive deterministic execution to its next host-effect or completion boundary.
    pub fn advance(&mut self, input: PlanApplyInput) -> Result<PlanStep, ExecutorError> {
        self.advance_inner(input).map_err(|code| ExecutorError {
            code,
            category: "execution",
        })
    }

    /// Inspect a partition without encoding a transport payload or allocating a handle.
    #[must_use]
    pub fn inspect(&self) -> PlanReceipt {
        PlanReceipt {
            canonical_hash: self.canonical_hash,
            strategy_ref: self.strategy_ref.clone(),
            logical_time: self.kernel.logical_time(),
            state_digest: self.kernel.state_digest(),
            agents: started_agent_summaries(self),
        }
    }
}

impl PlanRuntime {
    fn advance_inner(&mut self, input: PlanApplyInput) -> Result<PlanStep, &'static str> {
        match (self.pending.take(), input) {
            (None, PlanApplyInput::Continue) => {}
            (Some(pending), PlanApplyInput::Continue) => {
                self.pending = Some(pending);
                return Err("PLAN_EFFECT_RESULT_REQUIRED");
            }
            (None, PlanApplyInput::EffectResult { .. }) => return Err("PLAN_EFFECT_NOT_PENDING"),
            (Some((expected, agent_index)), PlanApplyInput::EffectResult { effect_id, result }) => {
                if expected != effect_id {
                    self.pending = Some((expected, agent_index));
                    return Err("PLAN_EFFECT_ID_MISMATCH");
                }
                let (budget_kind, budget_amount) = pending_call_budget(&self.agents[agent_index])
                    .ok_or("PLAN_EFFECT_NOT_AT_CALL")?;
                let agent = &mut self.agents[agent_index];
                if let Ok(value) = result {
                    self.kernel
                        .budget_mut(agent.process_id)
                        .and_then(|budget| budget.settle(budget_kind, budget_amount, budget_amount))
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
                        .and_then(|budget| budget.release(budget_kind, budget_amount))
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
                return Ok(PlanStep::Completed(PlanCompletion {
                    events: self.events.clone(),
                    outputs: self.outputs.clone(),
                }));
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
                    let (budget_kind, budget_amount) =
                        call_budget(&call).ok_or("PLAN_MATERIALIZATION_AGENT_BODY")?;
                    self.kernel
                        .budget_mut(agent.process_id)
                        .and_then(|budget| budget.reserve(budget_kind, budget_amount))
                        .map_err(|_| "PLAN_EFFECT_BUDGET")?;
                    self.kernel
                        .wait(agent.process_id)
                        .map_err(|_| "PLAN_PROCESS_WAIT")?;
                    self.next_effect_id = self.next_effect_id.saturating_add(1);
                    self.pending = Some((self.next_effect_id, index));
                    return Ok(PlanStep::EffectRequested(PlanEffectRequest {
                        effect_id: self.next_effect_id,
                        process_id: agent.process_id.bytes(),
                        operation: call.operation,
                        version: call.version,
                        arguments: call.arguments,
                    }));
                }
            }
        }
    }
}

fn supports_plan_effects(plan: &AdmittedPlan) -> bool {
    plan.approval_requirements.is_empty()
        && !plan.required_capabilities.iter().any(|value| {
            !matches!(
                value.as_str(),
                "agent.invoke.investigator"
                    | "llm.invoke.safe"
                    | "dkg.query"
                    | "dkg.sparql.read"
                    | "program.remote-execute"
                    | "dkg.asset.create"
            )
        })
        && !plan.effect_upper_bound.iter().any(|value| {
            !matches!(
                value,
                EffectClass::ModelInvocation
                    | EffectClass::Read
                    | EffectClass::RemoteExecution
                    | EffectClass::AssetCreation
            )
        })
        && !plan.adapter_versions.iter().any(|(operation, version)| {
            *version != 1
                || !matches!(
                    operation.as_str(),
                    "agent/investigate"
                        | "llm/safe"
                        | "dkg/query"
                        | "dkg/sparql-read"
                        | "remote-execute"
                        | "dkg/asset-create"
                )
        })
}

fn materialize_plan(plan: &AdmittedPlan, logical_time: u64) -> Result<PlanRuntime, &'static str> {
    if !supports_plan_effects(plan) {
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
        let model_call =
            has_call(&instructions, "agent/investigate") || has_call(&instructions, "llm/safe");
        let dkg_query =
            has_call(&instructions, "dkg/query") || has_call(&instructions, "dkg/sparql-read");
        let remote_execute = has_call(&instructions, "remote-execute")
            || has_call(&instructions, "dkg/asset-create");
        let (process_id, child) = materialize_agent(
            &plan.canonical_hash,
            &role,
            index,
            *max_restarts,
            model_call,
            dkg_query,
            remote_execute,
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
    dkg_query: bool,
    remote_execute: bool,
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
                (BudgetKind::ToolCalls, u64::from(remote_execute)),
                (BudgetKind::DkgQueries, u64::from(dkg_query)),
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
            if grants.iter().any(|value| {
                !matches!(
                    value.as_str(),
                    "agent.invoke.investigator"
                        | "llm.invoke.safe"
                        | "dkg.query"
                        | "dkg.sparql.read"
                        | "program.remote-execute"
                        | "dkg.asset.create"
                )
            }) {
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
        PlanExpr::Call(call)
            if call.version == 1
                && matches!(
                    call.operation.as_str(),
                    "agent/investigate"
                        | "llm/safe"
                        | "dkg/query"
                        | "dkg/sparql-read"
                        | "remote-execute"
                        | "dkg/asset-create"
                ) =>
        {
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

fn call_budget(call: &RegisteredCall) -> Option<(BudgetKind, u64)> {
    match (call.operation.as_str(), call.version) {
        ("agent/investigate" | "llm/safe", 1) => Some((BudgetKind::ModelTokens, 512)),
        ("dkg/query" | "dkg/sparql-read", 1) => Some((BudgetKind::DkgQueries, 1)),
        ("remote-execute" | "dkg/asset-create", 1) => Some((BudgetKind::ToolCalls, 1)),
        _ => None,
    }
}

fn pending_call_budget(agent: &PlanAgent) -> Option<(BudgetKind, u64)> {
    match agent.instructions.get(agent.cursor)? {
        PlanInstruction::Call(call) => call_budget(call),
        PlanInstruction::Emit(_) => None,
    }
}

fn has_call(instructions: &[PlanInstruction], operation: &str) -> bool {
    instructions.iter().any(|instruction| {
        matches!(instruction, PlanInstruction::Call(call) if call.operation == operation)
    })
}

fn derive_id(domain: &[u8], plan_hash: &[u8; 32], role: &str, index: u32) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(plan_hash);
    hasher.update(index.to_be_bytes());
    hasher.update(role.as_bytes());
    hasher.finalize().into()
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
