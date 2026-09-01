//! Deterministic admission compiler for the declarative strategy IR.

use std::collections::{BTreeMap, BTreeSet};

use dkg_ir::{
    Atom, Diagnostic, DiagnosticCode, RawNode, SourceSpan, Spanned, StrategyAst, form_head,
    required_atom_text,
};
use minicbor::{Decoder, Encoder};
use sha2::{Digest, Sha256};

/// Semantic compiler version included in every canonical plan.
pub const COMPILER_VERSION: &str = "1.0.0";
/// Strategy-schema version included in every canonical plan.
pub const STRATEGY_SCHEMA_VERSION: u16 = 1;
/// Maximum statically admitted processes in one execution.
pub const MAX_PROCESSES: u32 = 1_024;
/// Maximum plan nesting after typed lowering.
pub const MAX_PLAN_DEPTH: u16 = 64;
/// Maximum canonical plan bytes accepted by execution partitions.
pub const MAX_CANONICAL_PLAN_BYTES: usize = 4 * 1024 * 1024;

/// Stable failures while re-admitting a canonical plan in an execution
/// partition. Human diagnostics from source compilation remain separate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalPlanError {
    /// Plan exceeded the V1 byte ceiling.
    TooLarge,
    /// CBOR shape or a closed enum was invalid.
    Malformed,
    /// Strategy/compiler version was incompatible.
    VersionMismatch,
    /// Bytes did not use the one canonical encoding produced by this compiler.
    NonCanonical,
    /// A pinned adapter is absent or its schema changed.
    AdapterRegistryMismatch,
    /// Recomputed safety analysis or resource bounds did not match the plan.
    AnalysisMismatch,
}

impl CanonicalPlanError {
    /// Stable ABI code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TooLarge => "PLAN_TOO_LARGE",
            Self::Malformed => "PLAN_MALFORMED",
            Self::VersionMismatch => "PLAN_VERSION_MISMATCH",
            Self::NonCanonical => "PLAN_NON_CANONICAL",
            Self::AdapterRegistryMismatch => "PLAN_ADAPTER_REGISTRY_MISMATCH",
            Self::AnalysisMismatch => "PLAN_ANALYSIS_MISMATCH",
        }
    }
}

/// Broad protected/read effect classes known to admission and the broker.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum EffectClass {
    /// Read-only observation.
    Read,
    /// External inference that has cost but no mutation authority.
    ModelInvocation,
    /// Invocation of a DKG Program on an explicitly named remote node.
    RemoteExecution,
    /// Repository mutation.
    RepositoryWrite,
    /// Infrastructure mutation.
    InfrastructureChange,
    /// DKG or external publication.
    Publish,
    /// Monetary spend.
    Spend,
}

impl EffectClass {
    /// Stable identifier used in plans and approvals.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::ModelInvocation => "model-invocation",
            Self::RemoteExecution => "remote-execution",
            Self::RepositoryWrite => "repository-write",
            Self::InfrastructureChange => "infrastructure-change",
            Self::Publish => "publish",
            Self::Spend => "spend",
        }
    }

    /// Whether the class requires an explicit approval path in V1.
    #[must_use]
    pub const fn is_protected(self) -> bool {
        matches!(
            self,
            Self::RepositoryWrite | Self::InfrastructureChange | Self::Publish | Self::Spend
        )
    }
}

/// Adapter idempotency/reconciliation contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdempotencyClass {
    /// Pure read.
    ReadOnly,
    /// Repeating with the same stable effect identity is safe.
    Idempotent,
    /// Retry is safe only after adapter reconciliation.
    ReconcileBeforeRetry,
    /// One-shot action is not eligible for automatic runtime retry.
    OneShot,
}

/// Pinned, host-registered operation schema.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterOperation {
    /// Stable operation name without version suffix.
    pub id: String,
    /// Exact registry version.
    pub version: u16,
    /// Inferred capability requirement.
    pub capability: String,
    /// Inferred effect class.
    pub effect: EffectClass,
    /// Effect retry contract.
    pub idempotency: IdempotencyClass,
    /// Minimum scalar argument count.
    pub min_args: usize,
    /// Maximum scalar argument count.
    pub max_args: usize,
    /// Argument containing an exclusive-resource identity, if any.
    pub exclusive_resource_arg: Option<usize>,
    /// Temporary remediation must never be automatically repeated.
    pub temporary: bool,
}

impl AdapterOperation {
    /// Exact source-level reference.
    #[must_use]
    pub fn pinned_ref(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }
}

/// Closed adapter registry supplied by trusted host configuration.
#[derive(Clone, Debug, Default)]
pub struct AdapterRegistry {
    operations: BTreeMap<String, AdapterOperation>,
}

impl AdapterRegistry {
    /// Constructs an empty registry.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            operations: BTreeMap::new(),
        }
    }

    /// Registers one exact operation. Duplicate references are rejected.
    pub fn register(&mut self, operation: AdapterOperation) -> Result<(), &'static str> {
        if operation.id.is_empty()
            || operation.version == 0
            || operation.min_args > operation.max_args
        {
            return Err("INVALID_ADAPTER_SCHEMA");
        }
        let key = operation.pinned_ref();
        if self.operations.insert(key, operation).is_some() {
            return Err("DUPLICATE_ADAPTER_OPERATION");
        }
        Ok(())
    }

    /// Resolves an exact pinned reference.
    #[must_use]
    pub fn resolve(&self, pinned: &str) -> Option<&AdapterOperation> {
        self.operations.get(pinned)
    }

    /// Registry used by V1 conformance and Listener Boy integration.
    #[must_use]
    #[allow(clippy::too_many_lines)]
    pub fn v1() -> Self {
        let mut registry = Self::new();
        for operation in [
            adapter(
                "logs/read",
                1,
                "logs.read",
                EffectClass::Read,
                IdempotencyClass::ReadOnly,
                1,
                3,
                None,
                false,
            ),
            adapter(
                "dkg/query",
                1,
                "dkg.query",
                EffectClass::Read,
                IdempotencyClass::ReadOnly,
                1,
                3,
                None,
                false,
            ),
            adapter(
                "agent/investigate",
                1,
                "agent.invoke.investigator",
                EffectClass::ModelInvocation,
                IdempotencyClass::ReconcileBeforeRetry,
                1,
                1,
                None,
                false,
            ),
            adapter(
                "remote-execute",
                1,
                "program.remote-execute",
                EffectClass::RemoteExecution,
                IdempotencyClass::Idempotent,
                2,
                2,
                None,
                false,
            ),
            adapter(
                "agent/code",
                1,
                "agent.invoke.coder",
                EffectClass::RepositoryWrite,
                IdempotencyClass::ReconcileBeforeRetry,
                2,
                4,
                Some(0),
                false,
            ),
            adapter(
                "repository/apply-patch",
                1,
                "repository.write",
                EffectClass::RepositoryWrite,
                IdempotencyClass::ReconcileBeforeRetry,
                2,
                3,
                Some(0),
                false,
            ),
            adapter(
                "repository/run-ci",
                1,
                "repository.ci",
                EffectClass::Read,
                IdempotencyClass::Idempotent,
                1,
                2,
                None,
                false,
            ),
            adapter(
                "infra/drain-node",
                1,
                "infra.node.drain",
                EffectClass::InfrastructureChange,
                IdempotencyClass::OneShot,
                1,
                2,
                Some(0),
                true,
            ),
            adapter(
                "infra/restart-node",
                1,
                "infra.node.restart",
                EffectClass::InfrastructureChange,
                IdempotencyClass::OneShot,
                1,
                2,
                Some(0),
                true,
            ),
            adapter(
                "dkg/project-summary",
                1,
                "dkg.publish.semantic-summary",
                EffectClass::Publish,
                IdempotencyClass::Idempotent,
                2,
                4,
                Some(0),
                false,
            ),
        ] {
            registry
                .register(operation)
                .expect("built-in adapter schema is valid");
        }
        registry
    }
}

#[allow(clippy::too_many_arguments)]
fn adapter(
    id: &str,
    version: u16,
    capability: &str,
    effect: EffectClass,
    idempotency: IdempotencyClass,
    min_args: usize,
    max_args: usize,
    exclusive_resource_arg: Option<usize>,
    temporary: bool,
) -> AdapterOperation {
    AdapterOperation {
        id: id.to_string(),
        version,
        capability: capability.to_string(),
        effect,
        idempotency,
        min_args,
        max_args,
        exclusive_resource_arg,
        temporary,
    }
}

/// Exact resolved host operation embedded in an admitted plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegisteredCall {
    /// Operation name without version.
    pub operation: String,
    /// Exact version.
    pub version: u16,
    /// Canonical scalar arguments.
    pub arguments: Vec<String>,
    /// Inferred capability.
    pub capability: String,
    /// Inferred effect.
    pub effect: EffectClass,
    /// Retry/reconciliation contract.
    pub idempotency: IdempotencyClass,
    /// Optional exclusive resource.
    pub exclusive_resource: Option<String>,
    /// Temporary remediation marker.
    pub temporary: bool,
}

/// Typed immutable plan expression. No variant represents `eval` or arbitrary calls.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanExpr {
    /// Ordered children.
    Sequence(Vec<Spanned<PlanExpr>>),
    /// Bounded parallel children.
    Parallel {
        /// Maximum concurrently runnable branches.
        max_concurrency: u16,
        /// Ordered branches.
        children: Vec<Spanned<PlanExpr>>,
    },
    /// First terminal branch wins; branch count is its static bound.
    Race(Vec<Spanned<PlanExpr>>),
    /// Deterministic condition and body.
    When {
        /// Canonical data predicate.
        predicate: String,
        /// Conditional body.
        body: Box<Spanned<PlanExpr>>,
    },
    /// Registered read observation.
    Observe(RegisteredCall),
    /// Registered DKG/query read.
    Query(RegisteredCall),
    /// Local typed assertion data.
    Assert(String),
    /// Declarative supervisor boundary.
    Supervise {
        /// Restart strategy.
        strategy: SupervisorStrategy,
        /// Maximum restarts in the window.
        max_restarts: u16,
        /// Logical-time window.
        window_ms: u64,
        /// Ordered children/body.
        body: Box<Spanned<PlanExpr>>,
    },
    /// Bounded child delegation.
    Delegate {
        /// Stable child role.
        role: String,
        /// Explicitly requested attenuated capabilities.
        grants: BTreeSet<String>,
        /// Child body.
        body: Box<Spanned<PlanExpr>>,
    },
    /// One-way lifecycle monitor declaration.
    Monitor(String),
    /// Explicit shared-fate declaration; carries no authority.
    Link(String),
    /// Declared grant ceiling.
    Grant(String),
    /// Required capability.
    Require(String),
    /// Forbidden capability.
    Forbid(String),
    /// Protected-effect approval gate.
    Approval(EffectClass),
    /// Bounded automatic retry.
    Retry {
        /// Maximum attempts.
        max_attempts: u16,
        /// Retried body.
        body: Box<Spanned<PlanExpr>>,
    },
    /// Logical timeout.
    Timeout {
        /// Timeout in logical milliseconds.
        duration_ms: u64,
        /// Bounded body.
        body: Box<Spanned<PlanExpr>>,
    },
    /// Logical wait.
    Wait(u64),
    /// Typed cancellation target.
    Cancel(String),
    /// Redaction-safe semantic trace/projection candidate.
    Emit(String),
    /// Registered protected or read operation.
    Call(RegisteredCall),
    /// Exact pinned compensation strategy.
    Compensate(String),
    /// Statically bounded repetition.
    Repeat {
        /// Maximum iterations.
        max_iterations: u16,
        /// Repeated body.
        body: Box<Spanned<PlanExpr>>,
    },
    /// Event-driven reactivation creates a new execution.
    Trigger {
        /// Stable event class.
        event: String,
        /// Execution body.
        body: Box<Spanned<PlanExpr>>,
    },
}

/// OTP-observable supervisor strategies.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorStrategy {
    /// Restart only the failed child.
    OneForOne,
    /// Restart all children from the failed child onward.
    RestForOne,
    /// Restart all children.
    OneForAll,
}

impl SupervisorStrategy {
    const fn as_str(self) -> &'static str {
        match self {
            Self::OneForOne => "one-for-one",
            Self::RestForOne => "rest-for-one",
            Self::OneForAll => "one-for-all",
        }
    }
}

/// Conservative resource upper bounds calculated at admission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StaticBounds {
    /// Maximum logical processes.
    pub processes: u32,
    /// Maximum host calls over statically repeated paths.
    pub host_commands: u32,
    /// Maximum retry attempts across the plan tree.
    pub retry_attempts: u32,
    /// Maximum typed-plan depth.
    pub depth: u16,
}

/// Immutable compiler output consumed by the runtime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmittedPlan {
    /// Canonical plan identity.
    pub plan_id: [u8; 32],
    /// Strategy name and exact version.
    pub strategy_ref: String,
    /// Applicability scope.
    pub scope: String,
    /// Goal.
    pub goal: String,
    /// Typed immutable root.
    pub root: Spanned<PlanExpr>,
    /// Conservative effect upper bound.
    pub effect_upper_bound: BTreeSet<EffectClass>,
    /// Conservative capability requirements.
    pub required_capabilities: BTreeSet<String>,
    /// Explicit approval gates present in the plan.
    pub approval_requirements: BTreeSet<EffectClass>,
    /// Static resource upper bounds.
    pub resource_bounds: StaticBounds,
    /// Exact adapter versions.
    pub adapter_versions: BTreeMap<String, u16>,
    /// Deterministic canonical artifact bytes.
    pub canonical_plan_cbor: Vec<u8>,
    /// Domain-separated SHA-256 artifact hash.
    pub canonical_hash: [u8; 32],
}

/// Parses all forms, resolves registered operations, performs static safety
/// analysis, and emits a canonical immutable plan.
pub fn compile_strategy(
    strategy: &StrategyAst,
    registry: &AdapterRegistry,
) -> Result<AdmittedPlan, Vec<Diagnostic>> {
    let root = Spanned {
        value: PlanExpr::Sequence(
            strategy
                .body
                .iter()
                .map(|node| lower_expr(node, registry, 1))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        span: strategy.span,
    };

    let mut analysis = Analysis::default();
    analyze_expr(&root, &BTreeSet::new(), false, &mut analysis)?;
    let bounds = calculate_bounds(&root);
    if bounds.processes > MAX_PROCESSES || bounds.depth > MAX_PLAN_DEPTH {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::UnboundedRepeat,
            root.span,
            "static execution bounds exceed the V1 runtime ceiling",
        )]);
    }
    let strategy_ref = format!("{}@{}", strategy.id.value, strategy.version.value);
    let canonical_plan_cbor = encode_canonical_plan(
        &strategy_ref,
        &strategy.scope.value,
        &strategy.goal.value,
        &root,
        &analysis,
        bounds,
    );
    let canonical_hash: [u8; 32] = Sha256::digest(
        [
            b"DKG-STRATEGY-PLAN-V1\0".as_slice(),
            canonical_plan_cbor.as_slice(),
        ]
        .concat(),
    )
    .into();
    Ok(AdmittedPlan {
        plan_id: canonical_hash,
        strategy_ref,
        scope: strategy.scope.value.clone(),
        goal: strategy.goal.value.clone(),
        root,
        effect_upper_bound: analysis.effects,
        required_capabilities: analysis.capabilities,
        approval_requirements: analysis.approvals,
        resource_bounds: bounds,
        adapter_versions: analysis.adapter_versions,
        canonical_plan_cbor,
        canonical_hash,
    })
}

/// Strictly decodes and re-admits compiler-produced canonical plan bytes.
///
/// Execution partitions call this instead of trusting metadata supplied by a
/// graph, registry, or TypeScript caller. The function resolves every adapter
/// against the current closed registry, recomputes effects, capabilities,
/// approval paths, conflicts, and static bounds, then byte-compares the
/// canonical re-encoding.
pub fn admit_canonical_plan(
    input: &[u8],
    registry: &AdapterRegistry,
) -> Result<AdmittedPlan, CanonicalPlanError> {
    if input.len() > MAX_CANONICAL_PLAN_BYTES {
        return Err(CanonicalPlanError::TooLarge);
    }
    let mut decoder = Decoder::new(input);
    require_array(&mut decoder, 10)?;
    if decode_u16(&mut decoder)? != STRATEGY_SCHEMA_VERSION
        || decode_string(&mut decoder, 64)? != COMPILER_VERSION
    {
        return Err(CanonicalPlanError::VersionMismatch);
    }
    let strategy_ref = decode_string(&mut decoder, 512)?;
    if !valid_strategy_ref(&strategy_ref) {
        return Err(CanonicalPlanError::Malformed);
    }
    let scope = decode_nonempty_string(&mut decoder, 4_096)?;
    let goal = decode_nonempty_string(&mut decoder, 64 * 1024)?;
    let root = decode_expr(&mut decoder, registry, 1)?;
    let encoded_capabilities = decode_string_set(&mut decoder, 4_096, 1_024)?;
    let encoded_effects = decode_effect_set(&mut decoder)?;
    let encoded_adapters = decode_adapter_versions(&mut decoder)?;
    require_array(&mut decoder, 4)?;
    let encoded_bounds = StaticBounds {
        processes: decode_u32(&mut decoder)?,
        host_commands: decode_u32(&mut decoder)?,
        retry_attempts: decode_u32(&mut decoder)?,
        depth: decode_u16(&mut decoder)?,
    };
    if decoder.position() != input.len() {
        return Err(CanonicalPlanError::Malformed);
    }

    let mut analysis = Analysis::default();
    analyze_expr(&root, &BTreeSet::new(), false, &mut analysis)
        .map_err(|_| CanonicalPlanError::AnalysisMismatch)?;
    let bounds = calculate_bounds(&root);
    if bounds.processes > MAX_PROCESSES
        || bounds.depth > MAX_PLAN_DEPTH
        || analysis.capabilities != encoded_capabilities
        || analysis.effects != encoded_effects
        || analysis.adapter_versions != encoded_adapters
        || bounds != encoded_bounds
    {
        return Err(CanonicalPlanError::AnalysisMismatch);
    }
    let canonical = encode_canonical_plan(&strategy_ref, &scope, &goal, &root, &analysis, bounds);
    if canonical != input {
        return Err(CanonicalPlanError::NonCanonical);
    }
    let canonical_hash: [u8; 32] =
        Sha256::digest([b"DKG-STRATEGY-PLAN-V1\0".as_slice(), input].concat()).into();
    Ok(AdmittedPlan {
        plan_id: canonical_hash,
        strategy_ref,
        scope,
        goal,
        root,
        effect_upper_bound: analysis.effects,
        required_capabilities: analysis.capabilities,
        approval_requirements: analysis.approvals,
        resource_bounds: bounds,
        adapter_versions: analysis.adapter_versions,
        canonical_plan_cbor: canonical,
        canonical_hash,
    })
}

type CanonicalResult<T> = Result<T, CanonicalPlanError>;

#[allow(clippy::too_many_lines)]
fn decode_expr(
    decoder: &mut Decoder<'_>,
    registry: &AdapterRegistry,
    depth: u16,
) -> CanonicalResult<Spanned<PlanExpr>> {
    if depth > MAX_PLAN_DEPTH {
        return Err(CanonicalPlanError::AnalysisMismatch);
    }
    let length = require_definite_array(decoder)?;
    let tag = decode_u8(decoder)?;
    let value = match tag {
        0 | 2 => {
            if length != 2 {
                return Err(CanonicalPlanError::Malformed);
            }
            let children = decode_children(decoder, registry, depth)?;
            if tag == 0 {
                PlanExpr::Sequence(children)
            } else {
                PlanExpr::Race(children)
            }
        }
        1 => {
            if length != 3 {
                return Err(CanonicalPlanError::Malformed);
            }
            let max_concurrency = decode_u16(decoder)?;
            let children = decode_children(decoder, registry, depth)?;
            if max_concurrency == 0 || usize::from(max_concurrency) > children.len() {
                return Err(CanonicalPlanError::AnalysisMismatch);
            }
            PlanExpr::Parallel {
                max_concurrency,
                children,
            }
        }
        3 | 23 => {
            if length != 3 {
                return Err(CanonicalPlanError::Malformed);
            }
            let value = decode_nonempty_string(decoder, 64 * 1024)?;
            let body = Box::new(decode_expr(decoder, registry, depth.saturating_add(1))?);
            if tag == 3 {
                PlanExpr::When {
                    predicate: value,
                    body,
                }
            } else {
                PlanExpr::Trigger { event: value, body }
            }
        }
        4 | 5 | 20 => {
            if length != 4 {
                return Err(CanonicalPlanError::Malformed);
            }
            let call = decode_call(decoder, registry)?;
            match tag {
                4 => PlanExpr::Observe(call),
                5 => PlanExpr::Query(call),
                _ => PlanExpr::Call(call),
            }
        }
        6 | 9..=13 | 18 | 19 | 21 => {
            if length != 2 {
                return Err(CanonicalPlanError::Malformed);
            }
            let value = decode_nonempty_string(decoder, 64 * 1024)?;
            match tag {
                6 => PlanExpr::Assert(value),
                9 => PlanExpr::Monitor(value),
                10 => PlanExpr::Link(value),
                11 => PlanExpr::Grant(value),
                12 => PlanExpr::Require(value),
                13 => PlanExpr::Forbid(value),
                18 => PlanExpr::Cancel(value),
                19 => PlanExpr::Emit(value),
                _ => PlanExpr::Compensate(value),
            }
        }
        7 => {
            if length != 5 {
                return Err(CanonicalPlanError::Malformed);
            }
            let strategy = match decode_string(decoder, 32)?.as_str() {
                "one-for-one" => SupervisorStrategy::OneForOne,
                "rest-for-one" => SupervisorStrategy::RestForOne,
                "one-for-all" => SupervisorStrategy::OneForAll,
                _ => return Err(CanonicalPlanError::Malformed),
            };
            let max_restarts = decode_u16(decoder)?;
            let window_ms = decode_u64(decoder)?;
            if max_restarts == 0 || window_ms == 0 {
                return Err(CanonicalPlanError::AnalysisMismatch);
            }
            PlanExpr::Supervise {
                strategy,
                max_restarts,
                window_ms,
                body: Box::new(decode_expr(decoder, registry, depth.saturating_add(1))?),
            }
        }
        8 => {
            if length != 4 {
                return Err(CanonicalPlanError::Malformed);
            }
            PlanExpr::Delegate {
                role: decode_nonempty_string(decoder, 512)?,
                grants: decode_string_set(decoder, 4_096, 1_024)?,
                body: Box::new(decode_expr(decoder, registry, depth.saturating_add(1))?),
            }
        }
        14 => {
            if length != 2 {
                return Err(CanonicalPlanError::Malformed);
            }
            let effect = decode_effect_class(&decode_string(decoder, 64)?)?;
            if !effect.is_protected() {
                return Err(CanonicalPlanError::AnalysisMismatch);
            }
            PlanExpr::Approval(effect)
        }
        15 | 22 => {
            if length != 3 {
                return Err(CanonicalPlanError::Malformed);
            }
            let bound = decode_u16(decoder)?;
            if bound == 0 {
                return Err(CanonicalPlanError::AnalysisMismatch);
            }
            let body = Box::new(decode_expr(decoder, registry, depth.saturating_add(1))?);
            if tag == 15 {
                PlanExpr::Retry {
                    max_attempts: bound,
                    body,
                }
            } else {
                PlanExpr::Repeat {
                    max_iterations: bound,
                    body,
                }
            }
        }
        16 => {
            if length != 3 {
                return Err(CanonicalPlanError::Malformed);
            }
            let duration_ms = decode_u64(decoder)?;
            if duration_ms == 0 {
                return Err(CanonicalPlanError::AnalysisMismatch);
            }
            PlanExpr::Timeout {
                duration_ms,
                body: Box::new(decode_expr(decoder, registry, depth.saturating_add(1))?),
            }
        }
        17 => {
            if length != 2 {
                return Err(CanonicalPlanError::Malformed);
            }
            let duration_ms = decode_u64(decoder)?;
            if duration_ms == 0 {
                return Err(CanonicalPlanError::AnalysisMismatch);
            }
            PlanExpr::Wait(duration_ms)
        }
        _ => return Err(CanonicalPlanError::Malformed),
    };
    Ok(Spanned {
        value,
        span: SourceSpan::ZERO,
    })
}

fn decode_children(
    decoder: &mut Decoder<'_>,
    registry: &AdapterRegistry,
    depth: u16,
) -> CanonicalResult<Vec<Spanned<PlanExpr>>> {
    let count = require_definite_array(decoder)?;
    let count = usize::try_from(count).map_err(|_| CanonicalPlanError::TooLarge)?;
    if count == 0 || count > MAX_PROCESSES as usize {
        return Err(CanonicalPlanError::AnalysisMismatch);
    }
    (0..count)
        .map(|_| decode_expr(decoder, registry, depth.saturating_add(1)))
        .collect()
}

fn decode_call(
    decoder: &mut Decoder<'_>,
    registry: &AdapterRegistry,
) -> CanonicalResult<RegisteredCall> {
    let operation = decode_nonempty_string(decoder, 512)?;
    let version = decode_u16(decoder)?;
    let pinned = format!("{operation}@{version}");
    let schema = registry
        .resolve(&pinned)
        .ok_or(CanonicalPlanError::AdapterRegistryMismatch)?;
    let count = require_definite_array(decoder)?;
    let count = usize::try_from(count).map_err(|_| CanonicalPlanError::TooLarge)?;
    if count < schema.min_args || count > schema.max_args {
        return Err(CanonicalPlanError::AdapterRegistryMismatch);
    }
    let arguments = (0..count)
        .map(|_| decode_nonempty_string(decoder, 64 * 1024))
        .collect::<CanonicalResult<Vec<_>>>()?;
    let exclusive_resource = schema
        .exclusive_resource_arg
        .and_then(|index| arguments.get(index).cloned());
    Ok(RegisteredCall {
        operation,
        version,
        arguments,
        capability: schema.capability.clone(),
        effect: schema.effect,
        idempotency: schema.idempotency,
        exclusive_resource,
        temporary: schema.temporary,
    })
}

fn decode_string_set(
    decoder: &mut Decoder<'_>,
    max_string_bytes: usize,
    max_count: usize,
) -> CanonicalResult<BTreeSet<String>> {
    let count = require_definite_array(decoder)?;
    let count = usize::try_from(count).map_err(|_| CanonicalPlanError::TooLarge)?;
    if count > max_count {
        return Err(CanonicalPlanError::TooLarge);
    }
    let mut values = BTreeSet::new();
    for _ in 0..count {
        if !values.insert(decode_nonempty_string(decoder, max_string_bytes)?) {
            return Err(CanonicalPlanError::NonCanonical);
        }
    }
    Ok(values)
}

fn decode_effect_set(decoder: &mut Decoder<'_>) -> CanonicalResult<BTreeSet<EffectClass>> {
    let count = require_definite_array(decoder)?;
    if count > 7 {
        return Err(CanonicalPlanError::Malformed);
    }
    let mut effects = BTreeSet::new();
    for _ in 0..count {
        if !effects.insert(decode_effect_class(&decode_string(decoder, 64)?)?) {
            return Err(CanonicalPlanError::NonCanonical);
        }
    }
    Ok(effects)
}

fn decode_effect_class(value: &str) -> CanonicalResult<EffectClass> {
    match value {
        "read" => Ok(EffectClass::Read),
        "model-invocation" => Ok(EffectClass::ModelInvocation),
        "remote-execution" => Ok(EffectClass::RemoteExecution),
        "repository-write" => Ok(EffectClass::RepositoryWrite),
        "infrastructure-change" => Ok(EffectClass::InfrastructureChange),
        "publish" => Ok(EffectClass::Publish),
        "spend" => Ok(EffectClass::Spend),
        _ => Err(CanonicalPlanError::Malformed),
    }
}

fn decode_adapter_versions(decoder: &mut Decoder<'_>) -> CanonicalResult<BTreeMap<String, u16>> {
    let count = decoder
        .map()
        .map_err(|_| CanonicalPlanError::Malformed)?
        .ok_or(CanonicalPlanError::Malformed)?;
    if count > 1_024 {
        return Err(CanonicalPlanError::TooLarge);
    }
    let mut adapters = BTreeMap::new();
    for _ in 0..count {
        let operation = decode_nonempty_string(decoder, 512)?;
        let version = decode_u16(decoder)?;
        if version == 0 || adapters.insert(operation, version).is_some() {
            return Err(CanonicalPlanError::NonCanonical);
        }
    }
    Ok(adapters)
}

fn require_array(decoder: &mut Decoder<'_>, expected: u64) -> CanonicalResult<()> {
    if require_definite_array(decoder)? == expected {
        Ok(())
    } else {
        Err(CanonicalPlanError::Malformed)
    }
}

fn require_definite_array(decoder: &mut Decoder<'_>) -> CanonicalResult<u64> {
    decoder
        .array()
        .map_err(|_| CanonicalPlanError::Malformed)?
        .ok_or(CanonicalPlanError::Malformed)
}

fn decode_string(decoder: &mut Decoder<'_>, max_bytes: usize) -> CanonicalResult<String> {
    let value = decoder.str().map_err(|_| CanonicalPlanError::Malformed)?;
    if value.len() > max_bytes {
        return Err(CanonicalPlanError::TooLarge);
    }
    Ok(value.to_string())
}

fn decode_nonempty_string(decoder: &mut Decoder<'_>, max_bytes: usize) -> CanonicalResult<String> {
    let value = decode_string(decoder, max_bytes)?;
    if value.is_empty() {
        Err(CanonicalPlanError::Malformed)
    } else {
        Ok(value)
    }
}

fn decode_u8(decoder: &mut Decoder<'_>) -> CanonicalResult<u8> {
    decoder.u8().map_err(|_| CanonicalPlanError::Malformed)
}

fn decode_u16(decoder: &mut Decoder<'_>) -> CanonicalResult<u16> {
    decoder.u16().map_err(|_| CanonicalPlanError::Malformed)
}

fn decode_u32(decoder: &mut Decoder<'_>) -> CanonicalResult<u32> {
    decoder.u32().map_err(|_| CanonicalPlanError::Malformed)
}

fn decode_u64(decoder: &mut Decoder<'_>) -> CanonicalResult<u64> {
    decoder.u64().map_err(|_| CanonicalPlanError::Malformed)
}

fn valid_strategy_ref(value: &str) -> bool {
    let Some((name, version)) = value.rsplit_once('@') else {
        return false;
    };
    !name.is_empty()
        && name.len() <= 256
        && version.split('.').count() == 3
        && version.split('.').all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        })
}

#[allow(clippy::too_many_lines)]
fn lower_expr(
    node: &RawNode,
    registry: &AdapterRegistry,
    depth: u16,
) -> Result<Spanned<PlanExpr>, Vec<Diagnostic>> {
    if depth > MAX_PLAN_DEPTH {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::DepthLimit,
            node.span(),
            "typed plan exceeded maximum depth",
        )]);
    }
    let items = node
        .as_list()
        .ok_or_else(|| schema(node, "plan expression must be a list"))?;
    let head =
        form_head(node).ok_or_else(|| schema(node, "plan expression needs a symbolic head"))?;
    let args = &items[1..];
    let value = match head {
        "sequence" => PlanExpr::Sequence(lower_children(args, registry, depth)?),
        "parallel" => {
            let (max_concurrency, children) = bounded_children(args, "max", node.span())?;
            if children.is_empty() || usize::from(max_concurrency) > children.len() {
                return Err(schema(
                    node,
                    "parallel bound must be within its branch count",
                ));
            }
            PlanExpr::Parallel {
                max_concurrency,
                children: lower_children(children, registry, depth)?,
            }
        }
        "race" => {
            if args.len() < 2 {
                return Err(schema(
                    node,
                    "race requires at least two statically known branches",
                ));
            }
            PlanExpr::Race(lower_children(args, registry, depth)?)
        }
        "when" => {
            if args.len() < 2 {
                return Err(schema(node, "when requires a predicate and body"));
            }
            PlanExpr::When {
                predicate: canonical_data(&args[0])?,
                body: Box::new(sequence_or_one(&args[1..], registry, depth)?),
            }
        }
        "observe" => PlanExpr::Observe(lower_call(args, registry, node.span())?),
        "query" => PlanExpr::Query(lower_call(args, registry, node.span())?),
        "call" => PlanExpr::Call(lower_call(args, registry, node.span())?),
        "assert" => PlanExpr::Assert(canonical_args(args, node.span())?),
        "emit" => PlanExpr::Emit(canonical_args(args, node.span())?),
        "supervise" => lower_supervise(args, registry, depth, node.span())?,
        "delegate" => lower_delegate(args, registry, depth, node.span())?,
        "monitor" => PlanExpr::Monitor(exact_scalar(args, node.span(), "monitor target")?),
        "link" => PlanExpr::Link(exact_scalar(args, node.span(), "link target")?),
        "grant" => PlanExpr::Grant(exact_scalar(args, node.span(), "capability")?),
        "require" => PlanExpr::Require(exact_scalar(args, node.span(), "capability")?),
        "forbid" => PlanExpr::Forbid(exact_scalar(args, node.span(), "capability")?),
        "approve" => PlanExpr::Approval(parse_effect_class(
            &exact_scalar(args, node.span(), "effect class")?,
            node.span(),
        )?),
        "retry" => {
            let (max_attempts, children) = bounded_children(args, "max", node.span())?;
            if children.is_empty() {
                return Err(schema(node, "retry requires a body"));
            }
            PlanExpr::Retry {
                max_attempts,
                body: Box::new(sequence_or_one(children, registry, depth)?),
            }
        }
        "repeat" => {
            let (max_iterations, children) = bounded_children(args, "max", node.span())?;
            if children.is_empty() {
                return Err(schema(node, "repeat requires a body"));
            }
            PlanExpr::Repeat {
                max_iterations,
                body: Box::new(sequence_or_one(children, registry, depth)?),
            }
        }
        "timeout" => {
            let (duration_ms, children) = bounded_u64_children(args, "ms", node.span())?;
            if children.is_empty() {
                return Err(schema(node, "timeout requires a body"));
            }
            PlanExpr::Timeout {
                duration_ms,
                body: Box::new(sequence_or_one(children, registry, depth)?),
            }
        }
        "wait" => {
            let (duration_ms, children) = bounded_u64_children(args, "ms", node.span())?;
            if !children.is_empty() {
                return Err(schema(node, "wait accepts only (ms N)"));
            }
            PlanExpr::Wait(duration_ms)
        }
        "cancel" => PlanExpr::Cancel(exact_scalar(args, node.span(), "cancel target")?),
        "compensate" => {
            let reference = exact_scalar(args, node.span(), "strategy reference")?;
            if parse_pinned_ref(&reference).is_none() {
                return Err(vec![Diagnostic::new(
                    DiagnosticCode::AdapterOperationMustBePinned,
                    node.span(),
                    "compensation strategy must be exact-version pinned",
                )]);
            }
            PlanExpr::Compensate(reference)
        }
        "trigger" => {
            if args.len() < 2 {
                return Err(schema(node, "trigger requires an event class and body"));
            }
            PlanExpr::Trigger {
                event: required_atom_text(&args[0], "trigger event")?,
                body: Box::new(sequence_or_one(&args[1..], registry, depth)?),
            }
        }
        "eval" | "apply" | "lambda" | "quote" | "quasiquote" | "unquote" | "unquote-splicing" => {
            return Err(vec![Diagnostic::new(
                DiagnosticCode::UnknownForm,
                node.span(),
                format!("executable Lisp form `{head}` is not part of the strategy IR"),
            )]);
        }
        _ => {
            return Err(vec![Diagnostic::new(
                if head == "repeat" {
                    DiagnosticCode::UnboundedRepeat
                } else {
                    DiagnosticCode::UnknownForm
                },
                node.span(),
                format!("unknown declarative strategy form `{head}`"),
            )]);
        }
    };
    Ok(Spanned {
        value,
        span: node.span(),
    })
}

fn lower_children(
    children: &[RawNode],
    registry: &AdapterRegistry,
    depth: u16,
) -> Result<Vec<Spanned<PlanExpr>>, Vec<Diagnostic>> {
    children
        .iter()
        .map(|child| lower_expr(child, registry, depth + 1))
        .collect()
}

fn sequence_or_one(
    children: &[RawNode],
    registry: &AdapterRegistry,
    depth: u16,
) -> Result<Spanned<PlanExpr>, Vec<Diagnostic>> {
    if children.len() == 1 {
        return lower_expr(&children[0], registry, depth + 1);
    }
    let span = children.first().map_or(SourceSpan::ZERO, RawNode::span);
    Ok(Spanned {
        value: PlanExpr::Sequence(lower_children(children, registry, depth + 1)?),
        span,
    })
}

fn lower_call(
    args: &[RawNode],
    registry: &AdapterRegistry,
    span: SourceSpan,
) -> Result<RegisteredCall, Vec<Diagnostic>> {
    let Some(operation_node) = args.first() else {
        return Err(schema_span(span, "registered operation is required"));
    };
    let pinned = required_atom_text(operation_node, "registered operation")?;
    if parse_pinned_ref(&pinned).is_none() {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::AdapterOperationMustBePinned,
            operation_node.span(),
            "adapter operation must use exact name@version syntax",
        )]);
    }
    let Some(operation) = registry.resolve(&pinned) else {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::AdapterOperationMustBePinned,
            operation_node.span(),
            format!("operation `{pinned}` is not in the trusted adapter registry"),
        )]);
    };
    let call_args = &args[1..];
    if !(operation.min_args..=operation.max_args).contains(&call_args.len()) {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::SchemaMismatch,
            span,
            format!(
                "operation `{pinned}` expects {}..={} arguments, got {}",
                operation.min_args,
                operation.max_args,
                call_args.len(),
            ),
        )]);
    }
    let arguments = call_args
        .iter()
        .map(canonical_data)
        .collect::<Result<Vec<_>, _>>()?;
    let exclusive_resource = operation
        .exclusive_resource_arg
        .and_then(|index| arguments.get(index).cloned());
    Ok(RegisteredCall {
        operation: operation.id.clone(),
        version: operation.version,
        arguments,
        capability: operation.capability.clone(),
        effect: operation.effect,
        idempotency: operation.idempotency,
        exclusive_resource,
        temporary: operation.temporary,
    })
}

fn lower_supervise(
    args: &[RawNode],
    registry: &AdapterRegistry,
    depth: u16,
    span: SourceSpan,
) -> Result<PlanExpr, Vec<Diagnostic>> {
    if args.len() < 4 {
        return Err(schema_span(
            span,
            "supervise requires strategy, max-restarts, window-ms and body",
        ));
    }
    let strategy = match required_atom_text(&args[0], "supervisor strategy")?.as_str() {
        "one-for-one" => SupervisorStrategy::OneForOne,
        "rest-for-one" => SupervisorStrategy::RestForOne,
        "one-for-all" => SupervisorStrategy::OneForAll,
        _ => return Err(schema(&args[0], "unknown supervisor strategy")),
    };
    let max_restarts = bounded_value(&args[1], "max-restarts", span)?;
    let window_ms = bounded_u64_value(&args[2], "window-ms", span)?;
    Ok(PlanExpr::Supervise {
        strategy,
        max_restarts,
        window_ms,
        body: Box::new(sequence_or_one(&args[3..], registry, depth)?),
    })
}

fn lower_delegate(
    args: &[RawNode],
    registry: &AdapterRegistry,
    depth: u16,
    span: SourceSpan,
) -> Result<PlanExpr, Vec<Diagnostic>> {
    if args.len() < 2 {
        return Err(schema_span(span, "delegate requires a child role and body"));
    }
    let role = required_atom_text(&args[0], "delegate role")?;
    let mut index = 1;
    let mut grants = BTreeSet::new();
    while let Some(node) = args.get(index) {
        if form_head(node) != Some("grant") {
            break;
        }
        let items = node.as_list().expect("form_head established list");
        if items.len() != 2 {
            return Err(schema(node, "delegate grant must contain one capability"));
        }
        grants.insert(required_atom_text(&items[1], "capability")?);
        index += 1;
    }
    if index >= args.len() {
        return Err(schema_span(span, "delegate requires a body after grants"));
    }
    Ok(PlanExpr::Delegate {
        role,
        grants,
        body: Box::new(sequence_or_one(&args[index..], registry, depth)?),
    })
}

fn bounded_children<'a>(
    args: &'a [RawNode],
    keyword: &str,
    span: SourceSpan,
) -> Result<(u16, &'a [RawNode]), Vec<Diagnostic>> {
    let Some(bound) = args.first() else {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::UnboundedRepeat,
            span,
            format!("bounded form requires ({keyword} N)"),
        )]);
    };
    Ok((bounded_value(bound, keyword, span)?, &args[1..]))
}

fn bounded_u64_children<'a>(
    args: &'a [RawNode],
    keyword: &str,
    span: SourceSpan,
) -> Result<(u64, &'a [RawNode]), Vec<Diagnostic>> {
    let Some(bound) = args.first() else {
        return Err(schema_span(
            span,
            &format!("bounded form requires ({keyword} N)"),
        ));
    };
    Ok((bounded_u64_value(bound, keyword, span)?, &args[1..]))
}

fn bounded_value(node: &RawNode, keyword: &str, span: SourceSpan) -> Result<u16, Vec<Diagnostic>> {
    let value = bounded_u64_value(node, keyword, span)?;
    u16::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| schema(node, "bound must be a positive 16-bit integer"))
}

fn bounded_u64_value(
    node: &RawNode,
    keyword: &str,
    _span: SourceSpan,
) -> Result<u64, Vec<Diagnostic>> {
    let items = node
        .as_list()
        .ok_or_else(|| schema(node, "bound must be a list"))?;
    if items.len() != 2 || form_head(node) != Some(keyword) {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::UnboundedRepeat,
            node.span(),
            format!("expected explicit ({keyword} N) bound"),
        )]);
    }
    match items[1].as_atom() {
        Some(Atom::Integer(value)) if *value > 0 => {
            Ok(u64::try_from(*value).expect("positive i64 always fits u64"))
        }
        _ => Err(schema(&items[1], "bound must be a positive integer")),
    }
}

fn exact_scalar(
    args: &[RawNode],
    span: SourceSpan,
    context: &str,
) -> Result<String, Vec<Diagnostic>> {
    if args.len() != 1 {
        return Err(schema_span(
            span,
            &format!("{context} requires exactly one value"),
        ));
    }
    required_atom_text(&args[0], context)
}

fn canonical_args(args: &[RawNode], span: SourceSpan) -> Result<String, Vec<Diagnostic>> {
    if args.is_empty() {
        return Err(schema_span(
            span,
            "form requires at least one data argument",
        ));
    }
    args.iter()
        .map(canonical_data)
        .collect::<Result<Vec<_>, _>>()
        .map(|values| values.join("|"))
}

fn canonical_data(node: &RawNode) -> Result<String, Vec<Diagnostic>> {
    match node {
        RawNode::Atom(value) => Ok(value.value.canonical_text()),
        RawNode::List(value) => {
            let children = value
                .value
                .iter()
                .map(canonical_data)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("({})", children.join(" ")))
        }
    }
}

fn parse_effect_class(value: &str, span: SourceSpan) -> Result<EffectClass, Vec<Diagnostic>> {
    match value {
        "repository-write" => Ok(EffectClass::RepositoryWrite),
        "infrastructure-change" => Ok(EffectClass::InfrastructureChange),
        "publish" => Ok(EffectClass::Publish),
        "spend" => Ok(EffectClass::Spend),
        _ => Err(schema_span(
            span,
            "approval names an unknown protected effect class",
        )),
    }
}

fn parse_pinned_ref(value: &str) -> Option<(&str, u16)> {
    let (name, version) = value.rsplit_once('@')?;
    if name.is_empty() || version.is_empty() || version.starts_with('0') && version != "0" {
        return None;
    }
    let version = version.parse::<u16>().ok()?;
    (version > 0).then_some((name, version))
}

fn schema(node: &RawNode, message: &str) -> Vec<Diagnostic> {
    schema_span(node.span(), message)
}

fn schema_span(span: SourceSpan, message: &str) -> Vec<Diagnostic> {
    vec![Diagnostic::new(
        DiagnosticCode::SchemaMismatch,
        span,
        message,
    )]
}

#[derive(Default)]
struct Analysis {
    effects: BTreeSet<EffectClass>,
    capabilities: BTreeSet<String>,
    approvals: BTreeSet<EffectClass>,
    adapter_versions: BTreeMap<String, u16>,
    declared_grants: BTreeSet<String>,
    forbidden: BTreeSet<String>,
}

fn analyze_expr(
    expr: &Spanned<PlanExpr>,
    inherited_approvals: &BTreeSet<EffectClass>,
    in_retry: bool,
    analysis: &mut Analysis,
) -> Result<(), Vec<Diagnostic>> {
    match &expr.value {
        PlanExpr::Sequence(children) => {
            let mut approvals = inherited_approvals.clone();
            for child in children {
                if let PlanExpr::Approval(effect) = &child.value {
                    approvals.insert(*effect);
                    analysis.approvals.insert(*effect);
                }
                analyze_expr(child, &approvals, in_retry, analysis)?;
            }
        }
        PlanExpr::Parallel { children, .. } | PlanExpr::Race(children) => {
            reject_parallel_conflicts(children)?;
            for child in children {
                analyze_expr(child, inherited_approvals, in_retry, analysis)?;
            }
        }
        PlanExpr::When { body, .. }
        | PlanExpr::Timeout { body, .. }
        | PlanExpr::Repeat { body, .. }
        | PlanExpr::Trigger { body, .. }
        | PlanExpr::Supervise { body, .. } => {
            analyze_expr(body, inherited_approvals, in_retry, analysis)?;
        }
        PlanExpr::Delegate { grants, body, .. } => {
            let mut child = Analysis::default();
            analyze_expr(body, inherited_approvals, in_retry, &mut child)?;
            if !child.capabilities.is_subset(grants) {
                return Err(vec![Diagnostic::new(
                    DiagnosticCode::AuthorityBroadening,
                    expr.span,
                    "delegated body requires capabilities outside its explicit grant set",
                )]);
            }
            merge_analysis(analysis, child);
        }
        PlanExpr::Retry { body, .. } => {
            analyze_expr(body, inherited_approvals, true, analysis)?;
        }
        PlanExpr::Observe(call) | PlanExpr::Query(call) | PlanExpr::Call(call) => {
            analyze_call(call, expr.span, inherited_approvals, in_retry, analysis)?;
        }
        PlanExpr::Approval(effect) => {
            analysis.approvals.insert(*effect);
        }
        PlanExpr::Grant(capability) => {
            analysis.declared_grants.insert(capability.clone());
        }
        PlanExpr::Require(capability) => {
            if analysis.forbidden.contains(capability) {
                return Err(vec![Diagnostic::new(
                    DiagnosticCode::AuthorityBroadening,
                    expr.span,
                    "the same capability is both required and forbidden",
                )]);
            }
            analysis.capabilities.insert(capability.clone());
        }
        PlanExpr::Forbid(capability) => {
            if analysis.capabilities.contains(capability) {
                return Err(vec![Diagnostic::new(
                    DiagnosticCode::AuthorityBroadening,
                    expr.span,
                    "the same capability is both required and forbidden",
                )]);
            }
            analysis.forbidden.insert(capability.clone());
        }
        PlanExpr::Assert(_)
        | PlanExpr::Monitor(_)
        | PlanExpr::Link(_)
        | PlanExpr::Wait(_)
        | PlanExpr::Cancel(_)
        | PlanExpr::Emit(_)
        | PlanExpr::Compensate(_) => {}
    }
    Ok(())
}

fn analyze_call(
    call: &RegisteredCall,
    span: SourceSpan,
    approvals: &BTreeSet<EffectClass>,
    in_retry: bool,
    analysis: &mut Analysis,
) -> Result<(), Vec<Diagnostic>> {
    if call.effect.is_protected() && !approvals.contains(&call.effect) {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::ApprovalGap,
            span,
            format!(
                "{} requires an earlier `{}` approval gate",
                call.operation,
                call.effect.as_str()
            ),
        )]);
    }
    if in_retry && (call.temporary || call.idempotency == IdempotencyClass::OneShot) {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::TemporaryRetry,
            span,
            "temporary/one-shot effects cannot be nested in automatic retry",
        )]);
    }
    analysis.effects.insert(call.effect);
    analysis.capabilities.insert(call.capability.clone());
    analysis
        .adapter_versions
        .insert(call.operation.clone(), call.version);
    Ok(())
}

fn reject_parallel_conflicts(children: &[Spanned<PlanExpr>]) -> Result<(), Vec<Diagnostic>> {
    let mut resources = BTreeSet::new();
    for child in children {
        let mut child_resources = BTreeSet::new();
        collect_exclusive_resources(child, &mut child_resources);
        if child_resources
            .iter()
            .any(|resource| resources.contains(resource))
        {
            return Err(vec![Diagnostic::new(
                DiagnosticCode::ParallelConflict,
                child.span,
                "parallel branches claim the same exclusive resource",
            )]);
        }
        resources.extend(child_resources);
    }
    Ok(())
}

fn collect_exclusive_resources(expr: &Spanned<PlanExpr>, resources: &mut BTreeSet<String>) {
    match &expr.value {
        PlanExpr::Observe(call) | PlanExpr::Query(call) | PlanExpr::Call(call) => {
            if let Some(resource) = &call.exclusive_resource {
                resources.insert(format!("{}:{resource}", call.operation));
            }
        }
        PlanExpr::Sequence(children)
        | PlanExpr::Race(children)
        | PlanExpr::Parallel { children, .. } => {
            for child in children {
                collect_exclusive_resources(child, resources);
            }
        }
        PlanExpr::When { body, .. }
        | PlanExpr::Supervise { body, .. }
        | PlanExpr::Delegate { body, .. }
        | PlanExpr::Retry { body, .. }
        | PlanExpr::Timeout { body, .. }
        | PlanExpr::Repeat { body, .. }
        | PlanExpr::Trigger { body, .. } => collect_exclusive_resources(body, resources),
        _ => {}
    }
}

fn merge_analysis(target: &mut Analysis, source: Analysis) {
    target.effects.extend(source.effects);
    target.capabilities.extend(source.capabilities);
    target.approvals.extend(source.approvals);
    target.adapter_versions.extend(source.adapter_versions);
    target.declared_grants.extend(source.declared_grants);
    target.forbidden.extend(source.forbidden);
}

fn calculate_bounds(root: &Spanned<PlanExpr>) -> StaticBounds {
    fn walk(expr: &Spanned<PlanExpr>, depth: u16) -> (u32, u32, u32, u16) {
        let (mut processes, mut commands, mut retries, mut max_depth): (u32, u32, u32, u16) =
            (1, 0, 0, depth);
        match &expr.value {
            PlanExpr::Observe(_) | PlanExpr::Query(_) | PlanExpr::Call(_) => commands = 1,
            PlanExpr::Delegate { body, .. } => {
                let child = walk(body, depth.saturating_add(1));
                processes = processes.saturating_add(child.0);
                commands = child.1;
                retries = child.2;
                max_depth = child.3;
            }
            PlanExpr::Retry { max_attempts, body } => {
                let child = walk(body, depth.saturating_add(1));
                let factor = u32::from(*max_attempts);
                processes = child.0.saturating_mul(factor);
                commands = child.1.saturating_mul(factor);
                retries = child.2.saturating_add(factor.saturating_sub(1));
                max_depth = child.3;
            }
            PlanExpr::Repeat {
                max_iterations,
                body,
            } => {
                let child = walk(body, depth.saturating_add(1));
                let factor = u32::from(*max_iterations);
                processes = child.0.saturating_mul(factor);
                commands = child.1.saturating_mul(factor);
                retries = child.2;
                max_depth = child.3;
            }
            PlanExpr::Sequence(children)
            | PlanExpr::Race(children)
            | PlanExpr::Parallel { children, .. } => {
                for child in children {
                    let bound = walk(child, depth.saturating_add(1));
                    processes = processes.saturating_add(bound.0);
                    commands = commands.saturating_add(bound.1);
                    retries = retries.saturating_add(bound.2);
                    max_depth = max_depth.max(bound.3);
                }
            }
            PlanExpr::When { body, .. }
            | PlanExpr::Supervise { body, .. }
            | PlanExpr::Timeout { body, .. }
            | PlanExpr::Trigger { body, .. } => {
                let child = walk(body, depth.saturating_add(1));
                processes = child.0;
                commands = child.1;
                retries = child.2;
                max_depth = child.3;
            }
            _ => {}
        }
        (processes, commands, retries, max_depth)
    }
    let (processes, host_commands, retry_attempts, depth) = walk(root, 1);
    StaticBounds {
        processes,
        host_commands,
        retry_attempts,
        depth,
    }
}

fn encode_canonical_plan(
    strategy_ref: &str,
    scope: &str,
    goal: &str,
    root: &Spanned<PlanExpr>,
    analysis: &Analysis,
    bounds: StaticBounds,
) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = Encoder::new(&mut bytes);
    encoder.array(10).expect("Vec encoding cannot fail");
    encoder
        .u16(STRATEGY_SCHEMA_VERSION)
        .expect("Vec encoding cannot fail");
    encoder
        .str(COMPILER_VERSION)
        .expect("Vec encoding cannot fail");
    encoder.str(strategy_ref).expect("Vec encoding cannot fail");
    encoder.str(scope).expect("Vec encoding cannot fail");
    encoder.str(goal).expect("Vec encoding cannot fail");
    encode_expr(&mut encoder, &root.value);
    encode_string_set(&mut encoder, &analysis.capabilities);
    encoder
        .array(u64::try_from(analysis.effects.len()).expect("bounded effect set"))
        .expect("Vec encoding cannot fail");
    for effect in &analysis.effects {
        encoder
            .str(effect.as_str())
            .expect("Vec encoding cannot fail");
    }
    encoder
        .map(u64::try_from(analysis.adapter_versions.len()).expect("bounded adapter map"))
        .expect("Vec encoding cannot fail");
    for (adapter, version) in &analysis.adapter_versions {
        encoder.str(adapter).expect("Vec encoding cannot fail");
        encoder.u16(*version).expect("Vec encoding cannot fail");
    }
    encoder.array(4).expect("Vec encoding cannot fail");
    encoder
        .u32(bounds.processes)
        .expect("Vec encoding cannot fail");
    encoder
        .u32(bounds.host_commands)
        .expect("Vec encoding cannot fail");
    encoder
        .u32(bounds.retry_attempts)
        .expect("Vec encoding cannot fail");
    encoder.u16(bounds.depth).expect("Vec encoding cannot fail");
    bytes
}

fn encode_expr(encoder: &mut Encoder<&mut Vec<u8>>, expr: &PlanExpr) {
    match expr {
        PlanExpr::Sequence(children) => encode_children(encoder, 0, children),
        PlanExpr::Parallel {
            max_concurrency,
            children,
        } => {
            encoder.array(3).expect("Vec encoding cannot fail");
            encoder.u8(1).expect("Vec encoding cannot fail");
            encoder
                .u16(*max_concurrency)
                .expect("Vec encoding cannot fail");
            encode_child_array(encoder, children);
        }
        PlanExpr::Race(children) => encode_children(encoder, 2, children),
        PlanExpr::When { predicate, body } => {
            encode_tagged_string_body(encoder, 3, predicate, body);
        }
        PlanExpr::Observe(call) => encode_call(encoder, 4, call),
        PlanExpr::Query(call) => encode_call(encoder, 5, call),
        PlanExpr::Assert(value) => encode_tagged_string(encoder, 6, value),
        PlanExpr::Supervise {
            strategy,
            max_restarts,
            window_ms,
            body,
        } => {
            encoder.array(5).expect("Vec encoding cannot fail");
            encoder.u8(7).expect("Vec encoding cannot fail");
            encoder
                .str(strategy.as_str())
                .expect("Vec encoding cannot fail");
            encoder
                .u16(*max_restarts)
                .expect("Vec encoding cannot fail");
            encoder.u64(*window_ms).expect("Vec encoding cannot fail");
            encode_expr(encoder, &body.value);
        }
        PlanExpr::Delegate { role, grants, body } => {
            encoder.array(4).expect("Vec encoding cannot fail");
            encoder.u8(8).expect("Vec encoding cannot fail");
            encoder.str(role).expect("Vec encoding cannot fail");
            encode_string_set(encoder, grants);
            encode_expr(encoder, &body.value);
        }
        PlanExpr::Monitor(value) => encode_tagged_string(encoder, 9, value),
        PlanExpr::Link(value) => encode_tagged_string(encoder, 10, value),
        PlanExpr::Grant(value) => encode_tagged_string(encoder, 11, value),
        PlanExpr::Require(value) => encode_tagged_string(encoder, 12, value),
        PlanExpr::Forbid(value) => encode_tagged_string(encoder, 13, value),
        PlanExpr::Approval(effect) => encode_tagged_string(encoder, 14, effect.as_str()),
        PlanExpr::Retry { max_attempts, body } => {
            encode_tagged_u16_body(encoder, 15, *max_attempts, body);
        }
        PlanExpr::Timeout { duration_ms, body } => {
            encoder.array(3).expect("Vec encoding cannot fail");
            encoder.u8(16).expect("Vec encoding cannot fail");
            encoder.u64(*duration_ms).expect("Vec encoding cannot fail");
            encode_expr(encoder, &body.value);
        }
        PlanExpr::Wait(value) => encode_tagged_u64(encoder, 17, *value),
        PlanExpr::Cancel(value) => encode_tagged_string(encoder, 18, value),
        PlanExpr::Emit(value) => encode_tagged_string(encoder, 19, value),
        PlanExpr::Call(call) => encode_call(encoder, 20, call),
        PlanExpr::Compensate(value) => encode_tagged_string(encoder, 21, value),
        PlanExpr::Repeat {
            max_iterations,
            body,
        } => {
            encode_tagged_u16_body(encoder, 22, *max_iterations, body);
        }
        PlanExpr::Trigger { event, body } => {
            encode_tagged_string_body(encoder, 23, event, body);
        }
    }
}

fn encode_children(encoder: &mut Encoder<&mut Vec<u8>>, tag: u8, children: &[Spanned<PlanExpr>]) {
    encoder.array(2).expect("Vec encoding cannot fail");
    encoder.u8(tag).expect("Vec encoding cannot fail");
    encode_child_array(encoder, children);
}

fn encode_child_array(encoder: &mut Encoder<&mut Vec<u8>>, children: &[Spanned<PlanExpr>]) {
    encoder
        .array(u64::try_from(children.len()).expect("bounded child count"))
        .expect("Vec encoding cannot fail");
    for child in children {
        encode_expr(encoder, &child.value);
    }
}

fn encode_call(encoder: &mut Encoder<&mut Vec<u8>>, tag: u8, call: &RegisteredCall) {
    encoder.array(4).expect("Vec encoding cannot fail");
    encoder.u8(tag).expect("Vec encoding cannot fail");
    encoder
        .str(&call.operation)
        .expect("Vec encoding cannot fail");
    encoder.u16(call.version).expect("Vec encoding cannot fail");
    encoder
        .array(u64::try_from(call.arguments.len()).expect("bounded arguments"))
        .expect("Vec encoding cannot fail");
    for argument in &call.arguments {
        encoder.str(argument).expect("Vec encoding cannot fail");
    }
}

fn encode_tagged_string(encoder: &mut Encoder<&mut Vec<u8>>, tag: u8, value: &str) {
    encoder.array(2).expect("Vec encoding cannot fail");
    encoder.u8(tag).expect("Vec encoding cannot fail");
    encoder.str(value).expect("Vec encoding cannot fail");
}

fn encode_tagged_string_body(
    encoder: &mut Encoder<&mut Vec<u8>>,
    tag: u8,
    value: &str,
    body: &Spanned<PlanExpr>,
) {
    encoder.array(3).expect("Vec encoding cannot fail");
    encoder.u8(tag).expect("Vec encoding cannot fail");
    encoder.str(value).expect("Vec encoding cannot fail");
    encode_expr(encoder, &body.value);
}

fn encode_tagged_u16_body(
    encoder: &mut Encoder<&mut Vec<u8>>,
    tag: u8,
    value: u16,
    body: &Spanned<PlanExpr>,
) {
    encoder.array(3).expect("Vec encoding cannot fail");
    encoder.u8(tag).expect("Vec encoding cannot fail");
    encoder.u16(value).expect("Vec encoding cannot fail");
    encode_expr(encoder, &body.value);
}

fn encode_tagged_u64(encoder: &mut Encoder<&mut Vec<u8>>, tag: u8, value: u64) {
    encoder.array(2).expect("Vec encoding cannot fail");
    encoder.u8(tag).expect("Vec encoding cannot fail");
    encoder.u64(value).expect("Vec encoding cannot fail");
}

fn encode_string_set(encoder: &mut Encoder<&mut Vec<u8>>, values: &BTreeSet<String>) {
    encoder
        .array(u64::try_from(values.len()).expect("bounded string set"))
        .expect("Vec encoding cannot fail");
    for value in values {
        encoder.str(value).expect("Vec encoding cannot fail");
    }
}

#[cfg(test)]
mod tests {
    use dkg_ir::{AdmissionLimits, parse_strategy};

    use super::*;

    fn compile(source: &str) -> Result<AdmittedPlan, Vec<Diagnostic>> {
        let ast = parse_strategy(source, AdmissionLimits::default()).unwrap();
        compile_strategy(&ast, &AdapterRegistry::v1())
    }

    fn envelope(body: &str) -> String {
        format!(
            "(strategy listener-boy (version \"1.0.0\") (scope graph:incident) (goal investigate) {body})"
        )
    }

    #[test]
    fn canonical_plan_is_whitespace_stable_and_infers_upper_bounds() {
        let source = envelope(
            "(sequence (observe logs/read@1 node-a 50m) (approve repository-write) (call agent/code@1 repo-a issue-1))",
        );
        let first = compile(&source).unwrap();
        let second = compile(&source.replace(' ', "\n  ")).unwrap();
        assert_eq!(first.canonical_hash, second.canonical_hash);
        assert!(
            first
                .effect_upper_bound
                .contains(&EffectClass::RepositoryWrite)
        );
        assert!(first.required_capabilities.contains("logs.read"));
        assert_eq!(first.adapter_versions["agent/code"], 1);
    }

    #[test]
    fn rejects_evaluation_unpinned_operations_and_approval_gaps() {
        assert_eq!(
            compile(&envelope("(eval \"(call infra/drain-node)\")")).unwrap_err()[0].code,
            DiagnosticCode::UnknownForm,
        );
        assert_eq!(
            compile(&envelope("(call infra/drain-node node-a)")).unwrap_err()[0].code,
            DiagnosticCode::AdapterOperationMustBePinned,
        );
        assert_eq!(
            compile(&envelope("(call infra/drain-node@1 node-a)")).unwrap_err()[0].code,
            DiagnosticCode::ApprovalGap,
        );
    }

    #[test]
    fn rejects_unbounded_or_unsafe_retry_and_parallel_conflicts() {
        assert_eq!(
            compile(&envelope("(repeat (emit tick))")).unwrap_err()[0].code,
            DiagnosticCode::UnboundedRepeat,
        );
        let unsafe_retry = envelope(
            "(sequence (approve infrastructure-change) (retry (max 3) (call infra/restart-node@1 node-a)))",
        );
        assert_eq!(
            compile(&unsafe_retry).unwrap_err()[0].code,
            DiagnosticCode::TemporaryRetry,
        );
        let conflict = envelope(
            "(sequence (approve infrastructure-change) (parallel (max 2) (call infra/drain-node@1 node-a) (call infra/drain-node@1 node-a)))",
        );
        assert_eq!(
            compile(&conflict).unwrap_err()[0].code,
            DiagnosticCode::ParallelConflict,
        );
    }

    #[test]
    fn delegation_requires_an_explicit_capability_superset() {
        let bad = envelope(
            "(delegate investigator (grant logs.read) (call agent/investigate@1 incident))",
        );
        assert_eq!(
            compile(&bad).unwrap_err()[0].code,
            DiagnosticCode::AuthorityBroadening,
        );
        let good = envelope(
            "(delegate investigator (grant agent.invoke.investigator) (call agent/investigate@1 incident))",
        );
        assert!(compile(&good).is_ok());
    }

    #[test]
    fn investigator_requires_exactly_one_prompt_argument() {
        let no_prompt = envelope(
            "(delegate investigator (grant agent.invoke.investigator) (call agent/investigate@1))",
        );
        assert_eq!(
            compile(&no_prompt).unwrap_err()[0].code,
            DiagnosticCode::SchemaMismatch,
        );

        let one_prompt = envelope(
            "(delegate investigator (grant agent.invoke.investigator) (call agent/investigate@1 \"Say hi\"))",
        );
        assert!(compile(&one_prompt).is_ok());

        let extra_prompt = envelope(
            "(delegate investigator (grant agent.invoke.investigator) (call agent/investigate@1 \"Say hi\" \"ignored\"))",
        );
        assert_eq!(
            compile(&extra_prompt).unwrap_err()[0].code,
            DiagnosticCode::SchemaMismatch,
        );
    }

    #[test]
    fn remote_execute_requires_a_target_node_and_program() {
        let valid = envelope(
            "(delegate composer (grant program.remote-execute) (call remote-execute@1 peer-b urn:sr:program:child))",
        );
        let plan = compile(&valid).expect("typed remote execution is admitted");
        assert!(
            plan.required_capabilities
                .contains("program.remote-execute")
        );
        assert!(
            plan.effect_upper_bound
                .contains(&EffectClass::RemoteExecution)
        );

        let missing_program = envelope(
            "(delegate composer (grant program.remote-execute) (call remote-execute@1 peer-b))",
        );
        assert_eq!(
            compile(&missing_program).unwrap_err()[0].code,
            DiagnosticCode::SchemaMismatch,
        );
    }

    #[test]
    fn canonical_plan_is_recomputed_before_execution_admission() {
        let plan = compile(&envelope(
            "(sequence (observe logs/read@1 node-a 50m) (approve infrastructure-change) (call infra/drain-node@1 node-a))",
        ))
        .unwrap();
        let admitted = admit_canonical_plan(&plan.canonical_plan_cbor, &AdapterRegistry::v1())
            .expect("compiler output re-admits");
        assert_eq!(admitted.canonical_hash, plan.canonical_hash);
        assert_eq!(admitted.canonical_plan_cbor, plan.canonical_plan_cbor);
        assert_eq!(admitted.effect_upper_bound, plan.effect_upper_bound);
        assert_eq!(admitted.required_capabilities, plan.required_capabilities);
        assert_eq!(admitted.resource_bounds, plan.resource_bounds);

        assert_eq!(
            admit_canonical_plan(&plan.canonical_plan_cbor, &AdapterRegistry::new()),
            Err(CanonicalPlanError::AdapterRegistryMismatch),
        );

        let mut forged = plan.canonical_plan_cbor.clone();
        let capability = b"logs.read";
        let offset = forged
            .windows(capability.len())
            .position(|window| window == capability)
            .expect("fixture contains inferred capability");
        forged[offset..offset + capability.len()].copy_from_slice(b"logs.evil");
        assert_eq!(
            admit_canonical_plan(&forged, &AdapterRegistry::v1()),
            Err(CanonicalPlanError::AnalysisMismatch),
        );
    }
}
