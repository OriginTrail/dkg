//! Deterministic supervised logical processes, bounded mailboxes, and budgets.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use sha2::{Digest, Sha256};

/// Maximum logical transitions in one cooperative scheduler call.
pub const MAX_TRANSITIONS_PER_APPLY: u32 = 10_000;
/// Maximum generated host commands in one scheduler call.
pub const MAX_HOST_COMMANDS_PER_APPLY: u32 = 256;
/// Maximum runnable activations in one scheduler call.
pub const MAX_ACTIVATIONS_PER_APPLY: u32 = 1_024;
/// Maximum supervision depth.
pub const MAX_SUPERVISION_DEPTH: u16 = 64;
/// Maximum processes in one execution.
pub const MAX_PROCESSES_PER_EXECUTION: usize = 1_024;
/// Maximum consecutive high-priority activations before servicing one lower
/// priority runnable process.
pub const MAX_HIGH_PRIORITY_STREAK: u16 = 64;

/// Stable logical-process identifier.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ProcessId([u8; 32]);

impl ProcessId {
    /// Constructs a stable identifier.
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Identifier bytes.
    #[must_use]
    pub const fn bytes(self) -> [u8; 32] {
        self.0
    }
}

/// Stable process-spec identity.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ChildSpecId([u8; 32]);

impl ChildSpecId {
    /// Constructs a stable identifier.
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Opaque host capability reference. It is not a credential.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CapabilityRef([u8; 32]);

impl CapabilityRef {
    /// Constructs an opaque grant reference.
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Stable monitor identity.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct MonitorRef([u8; 32]);

impl MonitorRef {
    /// Constructs a monitor identity.
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Stable message identity used for replay deduplication and sampling.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct MessageId([u8; 32]);

impl MessageId {
    /// Constructs a stable message identity.
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    fn sample_bucket(self, denominator: u32) -> u32 {
        let mut prefix = [0u8; 8];
        prefix.copy_from_slice(&self.0[..8]);
        let value = u64::from_be_bytes(prefix);
        u32::try_from(value % u64::from(denominator)).expect("remainder fits u32")
    }
}

/// Deterministic scheduler priority. Lower enum order is higher priority.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Priority {
    /// Cancellation and supervisor control; reserved mailbox capacity.
    Control,
    /// Approval and authority revocation.
    Authority,
    /// Process lifecycle.
    Lifecycle,
    /// Evidence and ordinary results.
    Evidence,
    /// Shed-eligible observability traffic.
    Telemetry,
}

/// Typed message held inside a bounded mailbox.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MailboxMessage {
    /// Stable delivery identity.
    pub id: MessageId,
    /// Exact schema identity.
    pub schema_id: [u8; 32],
    /// Exact schema version.
    pub schema_version: u16,
    /// Canonical encoded payload.
    pub payload: Vec<u8>,
    /// Scheduler priority.
    pub priority: Priority,
    /// Optional deterministic coalescing key.
    pub coalesce_key: Option<String>,
    /// Optional logical expiry time.
    pub expires_at: Option<u64>,
}

impl MailboxMessage {
    /// Canonical storage bytes charged to mailbox bounds.
    #[must_use]
    pub fn encoded_bytes(&self) -> usize {
        32usize
            .saturating_add(32)
            .saturating_add(2)
            .saturating_add(1)
            .saturating_add(self.payload.len())
            .saturating_add(self.coalesce_key.as_ref().map_or(0, String::len))
            .saturating_add(9)
    }

    fn is_control(&self) -> bool {
        self.priority == Priority::Control
    }
}

/// Mailbox overload contract fixed by the admitted plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OverflowPolicy {
    /// Reject the new message.
    Reject,
    /// Replace an older message with the same explicit key.
    Coalesce,
    /// Keep a deterministic fraction by message identity.
    Sample {
        /// Accepted buckets.
        numerator: u32,
        /// Total buckets.
        denominator: u32,
    },
    /// Reject and signal upstream throttling.
    Throttle {
        /// Count below which the producer can resume.
        low_water_count: usize,
    },
    /// Drop only messages at or below the configured priority.
    ShedLowPriority {
        /// Minimum priority eligible for shedding.
        shed_from: Priority,
    },
    /// Ask the host to replace the payload with an immutable artifact ref.
    SpillReference,
}

/// Plan-fixed mailbox schema and capacity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MailboxSpec {
    /// Accepted schema identity.
    pub schema_id: [u8; 32],
    /// Accepted schema version.
    pub schema_version: u16,
    /// Total messages including reserved control capacity.
    pub max_count: usize,
    /// Total canonical bytes including reserved control capacity.
    pub max_bytes: usize,
    /// Maximum one-message bytes.
    pub max_message_bytes: usize,
    /// Slots unavailable to ordinary traffic.
    pub reserved_control_count: usize,
    /// Bytes unavailable to ordinary traffic.
    pub reserved_control_bytes: usize,
    /// Overload behavior.
    pub overflow: OverflowPolicy,
}

impl MailboxSpec {
    /// Validates all mailbox bounds before process creation.
    pub fn validate(&self) -> Result<(), KernelError> {
        if self.schema_version == 0
            || self.max_count == 0
            || self.max_bytes == 0
            || self.max_message_bytes == 0
            || self.max_message_bytes > self.max_bytes
            || self.reserved_control_count >= self.max_count
            || self.reserved_control_bytes >= self.max_bytes
        {
            return Err(KernelError::InvalidMailboxSpec);
        }
        match self.overflow {
            OverflowPolicy::Sample {
                numerator,
                denominator,
            } if denominator == 0 || numerator > denominator => {
                Err(KernelError::InvalidMailboxSpec)
            }
            OverflowPolicy::Throttle { low_water_count } if low_water_count >= self.max_count => {
                Err(KernelError::InvalidMailboxSpec)
            }
            _ => Ok(()),
        }
    }
}

/// Observable mailbox admission result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MailboxDecision {
    /// Message appended.
    Enqueued,
    /// Message rejected by bound or schema.
    Rejected,
    /// Older keyed update replaced.
    Coalesced,
    /// Message deterministically sampled out.
    SampledOut,
    /// Producer must pause until below its low-water mark.
    Throttled,
    /// Host must persist an artifact and retry with a reference.
    SpillRequired,
}

/// One bounded typed mailbox.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedMailbox {
    spec: MailboxSpec,
    messages: VecDeque<MailboxMessage>,
    bytes: usize,
    seen: BTreeSet<MessageId>,
}

impl BoundedMailbox {
    /// Constructs an empty validated mailbox.
    pub fn new(spec: MailboxSpec) -> Result<Self, KernelError> {
        spec.validate()?;
        Ok(Self {
            spec,
            messages: VecDeque::new(),
            bytes: 0,
            seen: BTreeSet::new(),
        })
    }

    /// Current message count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.messages.len()
    }

    /// Whether the mailbox is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Current canonical bytes.
    #[must_use]
    pub const fn bytes(&self) -> usize {
        self.bytes
    }

    /// Adds a message under schema, count, byte, and overload constraints.
    pub fn enqueue(&mut self, message: MailboxMessage) -> MailboxDecision {
        if self.seen.contains(&message.id) {
            return MailboxDecision::Enqueued;
        }
        let message_bytes = message.encoded_bytes();
        if message.schema_id != self.spec.schema_id
            || message.schema_version != self.spec.schema_version
            || message_bytes > self.spec.max_message_bytes
        {
            return MailboxDecision::Rejected;
        }
        if self.has_capacity(message_bytes, message.is_control()) {
            self.push(message, message_bytes);
            return MailboxDecision::Enqueued;
        }
        if message.is_control() {
            return MailboxDecision::Rejected;
        }
        match self.spec.overflow {
            OverflowPolicy::Reject => MailboxDecision::Rejected,
            OverflowPolicy::Coalesce => self.coalesce(message, message_bytes),
            OverflowPolicy::Sample {
                numerator,
                denominator,
            } => {
                if message.id.sample_bucket(denominator) >= numerator {
                    MailboxDecision::SampledOut
                } else {
                    MailboxDecision::Rejected
                }
            }
            OverflowPolicy::Throttle { .. } => MailboxDecision::Throttled,
            OverflowPolicy::ShedLowPriority { shed_from } => {
                if message.priority >= shed_from {
                    MailboxDecision::SampledOut
                } else {
                    MailboxDecision::Rejected
                }
            }
            OverflowPolicy::SpillReference => MailboxDecision::SpillRequired,
        }
    }

    /// Removes expired messages and returns their stable identities.
    pub fn expire(&mut self, logical_time: u64) -> Vec<MessageId> {
        let mut expired = Vec::new();
        let mut retained = VecDeque::new();
        while let Some(message) = self.messages.pop_front() {
            if message
                .expires_at
                .is_some_and(|expiry| expiry <= logical_time)
            {
                self.bytes = self.bytes.saturating_sub(message.encoded_bytes());
                self.seen.remove(&message.id);
                expired.push(message.id);
            } else {
                retained.push_back(message);
            }
        }
        self.messages = retained;
        expired
    }

    /// Pops the highest-priority message while preserving order in a class.
    pub fn pop(&mut self) -> Option<MailboxMessage> {
        let index = self
            .messages
            .iter()
            .enumerate()
            .min_by_key(|(index, message)| (message.priority, *index))?
            .0;
        let message = self.messages.remove(index)?;
        self.bytes = self.bytes.saturating_sub(message.encoded_bytes());
        self.seen.remove(&message.id);
        Some(message)
    }

    /// Whether a throttled producer may resume.
    #[must_use]
    pub fn below_low_water(&self) -> bool {
        match self.spec.overflow {
            OverflowPolicy::Throttle { low_water_count } => self.len() <= low_water_count,
            _ => true,
        }
    }

    fn has_capacity(&self, incoming: usize, control: bool) -> bool {
        let count_limit = if control {
            self.spec.max_count
        } else {
            self.spec
                .max_count
                .saturating_sub(self.spec.reserved_control_count)
        };
        let byte_limit = if control {
            self.spec.max_bytes
        } else {
            self.spec
                .max_bytes
                .saturating_sub(self.spec.reserved_control_bytes)
        };
        self.messages.len() < count_limit && self.bytes.saturating_add(incoming) <= byte_limit
    }

    fn push(&mut self, message: MailboxMessage, bytes: usize) {
        self.seen.insert(message.id);
        self.bytes = self.bytes.saturating_add(bytes);
        self.messages.push_back(message);
    }

    fn coalesce(&mut self, message: MailboxMessage, message_bytes: usize) -> MailboxDecision {
        let Some(key) = message.coalesce_key.as_ref() else {
            return MailboxDecision::Rejected;
        };
        let Some(index) = self
            .messages
            .iter()
            .position(|existing| existing.coalesce_key.as_ref() == Some(key))
        else {
            return MailboxDecision::Rejected;
        };
        let old_bytes = self.messages[index].encoded_bytes();
        let next_bytes = self
            .bytes
            .saturating_sub(old_bytes)
            .saturating_add(message_bytes);
        let ordinary_limit = self
            .spec
            .max_bytes
            .saturating_sub(self.spec.reserved_control_bytes);
        if next_bytes > ordinary_limit {
            return MailboxDecision::Rejected;
        }
        self.seen.remove(&self.messages[index].id);
        self.seen.insert(message.id);
        self.messages[index] = message;
        self.bytes = next_bytes;
        MailboxDecision::Coalesced
    }
}

/// Resource ledgers covered by hierarchical execution budgets.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum BudgetKind {
    /// Logical transitions.
    Steps,
    /// Model tokens.
    ModelTokens,
    /// External tool calls.
    ToolCalls,
    /// DKG queries.
    DkgQueries,
    /// Total bytes.
    Bytes,
    /// Child processes.
    ChildProcesses,
    /// Concurrent outstanding commands.
    OutstandingCommands,
    /// Retry/restart attempts.
    Restarts,
    /// Monetary spend in integer micro-units.
    SpendMicros,
}

/// One monotonic resource ledger.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BudgetAccount {
    /// Maximum permitted charge.
    pub limit: u64,
    /// Settled consumption, never reduced by restart.
    pub consumed: u64,
    /// Outstanding reservation.
    pub reserved: u64,
    /// Actual usage exceeded a reservation/limit.
    pub overdrawn: bool,
}

impl BudgetAccount {
    /// Remaining unreserved allowance.
    #[must_use]
    pub fn remaining(self) -> u64 {
        self.limit
            .saturating_sub(self.consumed)
            .saturating_sub(self.reserved)
    }
}

/// Hierarchical reservation-based budget ledger.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetLedger {
    accounts: BTreeMap<BudgetKind, BudgetAccount>,
}

impl BudgetLedger {
    /// Constructs accounts with zero consumption/reservation.
    #[must_use]
    pub fn new(limits: impl IntoIterator<Item = (BudgetKind, u64)>) -> Self {
        Self {
            accounts: limits
                .into_iter()
                .map(|(kind, limit)| {
                    (
                        kind,
                        BudgetAccount {
                            limit,
                            consumed: 0,
                            reserved: 0,
                            overdrawn: false,
                        },
                    )
                })
                .collect(),
        }
    }

    /// Account snapshot.
    #[must_use]
    pub fn account(&self, kind: BudgetKind) -> Option<BudgetAccount> {
        self.accounts.get(&kind).copied()
    }

    /// Atomically reserves allowance.
    pub fn reserve(&mut self, kind: BudgetKind, amount: u64) -> Result<(), KernelError> {
        let account = self
            .accounts
            .get_mut(&kind)
            .ok_or(KernelError::BudgetKindMissing)?;
        if account.overdrawn || amount > account.remaining() {
            return Err(KernelError::BudgetExhausted);
        }
        account.reserved = account.reserved.saturating_add(amount);
        Ok(())
    }

    /// Settles actual usage. Over-reservation is released; excess is recorded
    /// and marks the account overdrawn rather than losing the real charge.
    pub fn settle(
        &mut self,
        kind: BudgetKind,
        reserved: u64,
        actual: u64,
    ) -> Result<(), KernelError> {
        let account = self
            .accounts
            .get_mut(&kind)
            .ok_or(KernelError::BudgetKindMissing)?;
        if reserved > account.reserved {
            return Err(KernelError::BudgetReservationMismatch);
        }
        account.reserved -= reserved;
        account.consumed = account.consumed.saturating_add(actual);
        if actual > reserved || account.consumed > account.limit {
            account.overdrawn = true;
        }
        Ok(())
    }

    /// Releases an unused reservation without changing consumption.
    pub fn release(&mut self, kind: BudgetKind, amount: u64) -> Result<(), KernelError> {
        let account = self
            .accounts
            .get_mut(&kind)
            .ok_or(KernelError::BudgetKindMissing)?;
        if amount > account.reserved {
            return Err(KernelError::BudgetReservationMismatch);
        }
        account.reserved -= amount;
        Ok(())
    }
}

/// Restart eligibility fixed by the child spec.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestartClass {
    /// Restart after normal or abnormal termination (subject to authority/budget).
    Permanent,
    /// Restart only after abnormal termination.
    Transient,
    /// Never automatically restart.
    Temporary,
}

/// Supervisor sibling coordination strategy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestartStrategy {
    /// Restart only the failed child.
    OneForOne,
    /// Restart the failed child and later start-order siblings.
    RestForOne,
    /// Restart all children.
    OneForAll,
}

/// Explicit process termination classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminationReason {
    /// Normal completion.
    NormalCompleted,
    /// Cooperative cancellation.
    Cancelled,
    /// Supervisor shutdown.
    Shutdown,
    /// Stable failure code.
    Failure(String),
    /// Logical timeout.
    Timeout,
    /// Message/result schema violation.
    ProtocolViolation,
    /// Host grant revoked; explicit new grant is required.
    AuthorityRevoked,
    /// Budget is exhausted and cannot be reset by restart.
    BudgetExhausted,
    /// Monitor target did not exist.
    NoProcess,
}

impl TerminationReason {
    fn abnormal(&self) -> bool {
        matches!(
            self,
            Self::Failure(_) | Self::Timeout | Self::ProtocolViolation
        )
    }

    fn restart_blocked(&self) -> bool {
        matches!(self, Self::AuthorityRevoked | Self::BudgetExhausted)
    }
}

/// Process lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessStatus {
    /// Eligible for scheduling.
    Runnable,
    /// Waiting for an event/result.
    Waiting,
    /// Cooperative cancellation in progress.
    Cancelling {
        /// Logical shutdown deadline.
        deadline: u64,
    },
    /// Terminal state and reason.
    Terminated(TerminationReason),
}

/// Plan-fixed child specification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChildSpec {
    /// Stable spec identity.
    pub id: ChildSpecId,
    /// Restart eligibility.
    pub restart_class: RestartClass,
    /// Typed mailbox contract.
    pub mailbox: MailboxSpec,
    /// Logical shutdown timeout.
    pub shutdown_timeout_ms: u64,
    /// Opaque bound host grant.
    pub capability_ref: CapabilityRef,
    /// Initial budget used only for first construction.
    pub budget_limits: BTreeMap<BudgetKind, u64>,
}

/// One logical process record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogicalProcess {
    /// Stable runtime identity.
    pub id: ProcessId,
    /// Plan child spec.
    pub spec_id: ChildSpecId,
    /// Termination/restart generation.
    pub epoch: u64,
    /// Current lifecycle state.
    pub status: ProcessStatus,
    /// Private typed mailbox.
    pub mailbox: BoundedMailbox,
    /// Monotonic budget ledger retained across restart.
    pub budget: BudgetLedger,
    /// Opaque host grant retained/narrowed across restart.
    pub capability_ref: CapabilityRef,
}

/// Plan-fixed supervisor definition and persisted intensity state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Supervisor {
    /// Stable identity.
    pub id: ProcessId,
    /// Child start order.
    pub children: Vec<ProcessId>,
    /// Sibling coordination strategy.
    pub strategy: RestartStrategy,
    /// Maximum actual restarts in one window.
    pub max_restarts: u16,
    /// Logical intensity window.
    pub window_ms: u64,
    /// Persisted actual restart timestamps.
    pub restart_history: VecDeque<u64>,
    /// Intensity exhausted and subtree escalated.
    pub escalated: bool,
}

/// Explicit link failure policy.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum LinkFailurePolicy {
    /// Propagate only abnormal exits.
    PropagateAbnormal,
    /// Propagate every exit.
    PropagateAny,
    /// Observe without termination propagation.
    ObserveOnly,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Link {
    peer: ProcessId,
    policy: LinkFailurePolicy,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Monitor {
    source: ProcessId,
    target: ProcessId,
    reference: MonitorRef,
}

/// Observable lifecycle action emitted by one deterministic transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LifecycleEvent {
    /// Child restarted with the same authority and remaining budget.
    Restarted {
        /// Process.
        process: ProcessId,
        /// New generation.
        epoch: u64,
    },
    /// Temporary or ineligible child was not restarted.
    NotRestarted {
        /// Process.
        process: ProcessId,
        /// Reason.
        reason: TerminationReason,
    },
    /// Supervisor exceeded persisted restart intensity.
    SupervisorEscalated {
        /// Supervisor.
        supervisor: ProcessId,
    },
    /// One monitor received a process-down signal.
    ProcessDown {
        /// Monitoring process.
        observer: ProcessId,
        /// Monitor reference.
        reference: MonitorRef,
        /// Terminated target.
        target: ProcessId,
        /// Target generation.
        epoch: u64,
        /// Termination reason.
        reason: TerminationReason,
    },
    /// Link policy propagated termination.
    LinkExit {
        /// Linked peer.
        peer: ProcessId,
        /// Original target.
        from: ProcessId,
        /// Reason.
        reason: TerminationReason,
    },
}

/// Result of one bounded cooperative scheduler call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchedulerOutput {
    /// Messages processed.
    pub transitions: u32,
    /// Runnable activations.
    pub activations: u32,
    /// Reserved host command count.
    pub host_commands: u32,
    /// More runnable work remains.
    pub yielded: bool,
    /// Stable processed message identities.
    pub processed: Vec<(ProcessId, MessageId)>,
}

/// Snapshot contains replay-relevant state only; no credentials or host handles.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KernelSnapshot {
    logical_time: u64,
    process_sequence: u64,
    processes: BTreeMap<ProcessId, LogicalProcess>,
    specs: BTreeMap<ChildSpecId, ChildSpec>,
    supervisors: BTreeMap<ProcessId, Supervisor>,
    child_parent: BTreeMap<ProcessId, ProcessId>,
    monitors: BTreeSet<Monitor>,
    delivered_down: BTreeSet<(MonitorRef, ProcessId, u64)>,
    links: BTreeMap<ProcessId, BTreeSet<Link>>,
    runnable: BTreeMap<Priority, VecDeque<ProcessId>>,
    high_priority_streak: u16,
}

/// Deterministic supervised process kernel for one execution partition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupervisedKernel {
    logical_time: u64,
    process_sequence: u64,
    processes: BTreeMap<ProcessId, LogicalProcess>,
    specs: BTreeMap<ChildSpecId, ChildSpec>,
    supervisors: BTreeMap<ProcessId, Supervisor>,
    child_parent: BTreeMap<ProcessId, ProcessId>,
    monitors: BTreeSet<Monitor>,
    delivered_down: BTreeSet<(MonitorRef, ProcessId, u64)>,
    links: BTreeMap<ProcessId, BTreeSet<Link>>,
    runnable: BTreeMap<Priority, VecDeque<ProcessId>>,
    high_priority_streak: u16,
}

impl SupervisedKernel {
    /// Constructs an empty partition.
    #[must_use]
    pub fn new(logical_time: u64) -> Self {
        Self {
            logical_time,
            process_sequence: 0,
            processes: BTreeMap::new(),
            specs: BTreeMap::new(),
            supervisors: BTreeMap::new(),
            child_parent: BTreeMap::new(),
            monitors: BTreeSet::new(),
            delivered_down: BTreeSet::new(),
            links: BTreeMap::new(),
            runnable: BTreeMap::new(),
            high_priority_streak: 0,
        }
    }

    /// Current explicit logical time.
    #[must_use]
    pub const fn logical_time(&self) -> u64 {
        self.logical_time
    }

    /// Advances explicit logical time and expires queued messages.
    pub fn advance_time(&mut self, logical_time: u64) -> Result<Vec<MessageId>, KernelError> {
        if logical_time < self.logical_time {
            return Err(KernelError::LogicalTimeRegressed);
        }
        self.logical_time = logical_time;
        let mut expired = Vec::new();
        for process in self.processes.values_mut() {
            expired.extend(process.mailbox.expire(logical_time));
            if matches!(process.status, ProcessStatus::Cancelling { deadline } if deadline <= logical_time)
            {
                process.status = ProcessStatus::Terminated(TerminationReason::Cancelled);
            }
        }
        Ok(expired)
    }

    /// Creates a supervisor and its declared children in stable start order.
    pub fn spawn_supervisor(
        &mut self,
        supervisor_id: ProcessId,
        strategy: RestartStrategy,
        max_restarts: u16,
        window_ms: u64,
        children: Vec<(ProcessId, ChildSpec)>,
    ) -> Result<(), KernelError> {
        if self.supervisors.contains_key(&supervisor_id)
            || max_restarts == 0
            || window_ms == 0
            || self.processes.len().saturating_add(children.len()) > MAX_PROCESSES_PER_EXECUTION
        {
            return Err(KernelError::InvalidSupervisor);
        }
        let mut child_ids = Vec::with_capacity(children.len());
        for (process_id, spec) in children {
            if self.processes.contains_key(&process_id) || self.specs.contains_key(&spec.id) {
                return Err(KernelError::DuplicateIdentity);
            }
            let mailbox = BoundedMailbox::new(spec.mailbox.clone())?;
            let budget = BudgetLedger::new(
                spec.budget_limits
                    .iter()
                    .map(|(kind, limit)| (*kind, *limit)),
            );
            let process = LogicalProcess {
                id: process_id,
                spec_id: spec.id,
                epoch: 0,
                status: ProcessStatus::Runnable,
                mailbox,
                budget,
                capability_ref: spec.capability_ref,
            };
            self.specs.insert(spec.id, spec);
            self.child_parent.insert(process_id, supervisor_id);
            self.processes.insert(process_id, process);
            self.enqueue_runnable(process_id, Priority::Lifecycle);
            child_ids.push(process_id);
        }
        self.supervisors.insert(
            supervisor_id,
            Supervisor {
                id: supervisor_id,
                children: child_ids,
                strategy,
                max_restarts,
                window_ms,
                restart_history: VecDeque::new(),
                escalated: false,
            },
        );
        Ok(())
    }

    /// Returns one process record.
    #[must_use]
    pub fn process(&self, process: ProcessId) -> Option<&LogicalProcess> {
        self.processes.get(&process)
    }

    /// Suspends a runnable process until an explicit host result arrives.
    pub fn wait(&mut self, process: ProcessId) -> Result<(), KernelError> {
        let process = self
            .processes
            .get_mut(&process)
            .ok_or(KernelError::ProcessNotFound)?;
        if matches!(process.status, ProcessStatus::Terminated(_)) {
            return Err(KernelError::ProcessTerminated);
        }
        process.status = ProcessStatus::Waiting;
        Ok(())
    }

    /// Makes a waiting process runnable after an explicit host result.
    pub fn wake(&mut self, process: ProcessId) -> Result<(), KernelError> {
        let target = self
            .processes
            .get_mut(&process)
            .ok_or(KernelError::ProcessNotFound)?;
        if matches!(target.status, ProcessStatus::Terminated(_)) {
            return Err(KernelError::ProcessTerminated);
        }
        target.status = ProcessStatus::Runnable;
        self.enqueue_runnable(process, Priority::Evidence);
        Ok(())
    }

    /// Returns one mutable budget ledger for host result settlement.
    pub fn budget_mut(&mut self, process: ProcessId) -> Result<&mut BudgetLedger, KernelError> {
        self.processes
            .get_mut(&process)
            .map(|process| &mut process.budget)
            .ok_or(KernelError::ProcessNotFound)
    }

    /// Enqueues a typed process message and makes the process runnable.
    pub fn send(
        &mut self,
        process: ProcessId,
        message: MailboxMessage,
    ) -> Result<MailboxDecision, KernelError> {
        let priority = message.priority;
        let target = self
            .processes
            .get_mut(&process)
            .ok_or(KernelError::ProcessNotFound)?;
        if matches!(target.status, ProcessStatus::Terminated(_)) {
            return Err(KernelError::ProcessTerminated);
        }
        if matches!(target.status, ProcessStatus::Cancelling { .. })
            && priority != Priority::Control
        {
            return Ok(MailboxDecision::Rejected);
        }
        let decision = target.mailbox.enqueue(message);
        if matches!(
            decision,
            MailboxDecision::Enqueued | MailboxDecision::Coalesced
        ) {
            target.status = ProcessStatus::Runnable;
            self.enqueue_runnable(process, priority);
        }
        Ok(decision)
    }

    /// Requests cooperative cancellation through reserved control semantics.
    pub fn cancel(&mut self, process: ProcessId) -> Result<(), KernelError> {
        let target = self
            .processes
            .get_mut(&process)
            .ok_or(KernelError::ProcessNotFound)?;
        let spec = self
            .specs
            .get(&target.spec_id)
            .ok_or(KernelError::InvalidSnapshot)?;
        target.status = ProcessStatus::Cancelling {
            deadline: self.logical_time.saturating_add(spec.shutdown_timeout_ms),
        };
        self.enqueue_runnable(process, Priority::Control);
        Ok(())
    }

    /// Terminates one process, computes supervisor action, then monitor and
    /// link signals in the required deterministic ordering.
    #[allow(clippy::needless_pass_by_value)]
    pub fn terminate(
        &mut self,
        process_id: ProcessId,
        reason: TerminationReason,
    ) -> Result<Vec<LifecycleEvent>, KernelError> {
        let epoch = {
            let process = self
                .processes
                .get_mut(&process_id)
                .ok_or(KernelError::ProcessNotFound)?;
            process.epoch = process.epoch.saturating_add(1);
            process.status = ProcessStatus::Terminated(reason.clone());
            process.epoch
        };
        let mut events = self.supervise_termination(process_id, &reason)?;
        self.emit_monitor_events(process_id, epoch, &reason, &mut events);
        self.emit_link_events(process_id, &reason, &mut events);
        Ok(events)
    }

    /// Creates a one-way monitor. Missing/terminated targets immediately emit
    /// exactly one `NoProcess` down signal.
    pub fn monitor(
        &mut self,
        source: ProcessId,
        target: ProcessId,
        reference: MonitorRef,
    ) -> Result<Option<LifecycleEvent>, KernelError> {
        if !self.processes.contains_key(&source) {
            return Err(KernelError::ProcessNotFound);
        }
        let monitor = Monitor {
            source,
            target,
            reference,
        };
        if !self.monitors.insert(monitor) {
            return Ok(None);
        }
        let target_state = self.processes.get(&target);
        let unavailable = target_state
            .is_none_or(|process| matches!(process.status, ProcessStatus::Terminated(_)));
        if unavailable {
            let epoch = target_state.map_or(0, |process| process.epoch);
            let key = (reference, target, epoch);
            if self.delivered_down.insert(key) {
                return Ok(Some(LifecycleEvent::ProcessDown {
                    observer: source,
                    reference,
                    target,
                    epoch,
                    reason: TerminationReason::NoProcess,
                }));
            }
        }
        Ok(None)
    }

    /// Removes a monitor relationship. Already emitted events remain durable.
    pub fn demonitor(&mut self, reference: MonitorRef) -> bool {
        let before = self.monitors.len();
        self.monitors
            .retain(|monitor| monitor.reference != reference);
        before != self.monitors.len()
    }

    /// Creates a symmetric explicit link. Links never alter capabilities.
    pub fn link(
        &mut self,
        left: ProcessId,
        right: ProcessId,
        policy: LinkFailurePolicy,
    ) -> Result<(), KernelError> {
        if left == right
            || !self.processes.contains_key(&left)
            || !self.processes.contains_key(&right)
        {
            return Err(KernelError::ProcessNotFound);
        }
        self.links.entry(left).or_default().insert(Link {
            peer: right,
            policy,
        });
        self.links
            .entry(right)
            .or_default()
            .insert(Link { peer: left, policy });
        Ok(())
    }

    /// Runs a deterministic bounded activation loop. Actual behavior execution
    /// remains an explicit event/command reducer; this scheduler only delivers
    /// admitted messages and reports the continuation boundary.
    pub fn run_scheduler(&mut self) -> SchedulerOutput {
        let mut output = SchedulerOutput {
            transitions: 0,
            activations: 0,
            host_commands: 0,
            yielded: false,
            processed: Vec::new(),
        };
        'scheduler: while output.transitions < MAX_TRANSITIONS_PER_APPLY
            && output.activations < MAX_ACTIVATIONS_PER_APPLY
            && output.host_commands < MAX_HOST_COMMANDS_PER_APPLY
        {
            let Some((priority, process_id)) = self.next_runnable() else {
                break;
            };
            output.activations += 1;
            let Some(process) = self.processes.get_mut(&process_id) else {
                continue;
            };
            if !matches!(
                process.status,
                ProcessStatus::Runnable | ProcessStatus::Cancelling { .. }
            ) {
                continue;
            }
            let Some(message) = process.mailbox.pop() else {
                process.status = ProcessStatus::Waiting;
                continue;
            };
            output.transitions += 1;
            output.processed.push((process_id, message.id));
            if !process.mailbox.is_empty() {
                self.enqueue_runnable(process_id, priority);
            } else if matches!(process.status, ProcessStatus::Runnable) {
                process.status = ProcessStatus::Waiting;
            }
            if output.transitions >= MAX_TRANSITIONS_PER_APPLY {
                break 'scheduler;
            }
        }
        output.yielded = self.runnable.values().any(|queue| !queue.is_empty());
        output
    }

    /// Captures all replay-relevant state.
    #[must_use]
    pub fn snapshot(&self) -> KernelSnapshot {
        KernelSnapshot {
            logical_time: self.logical_time,
            process_sequence: self.process_sequence,
            processes: self.processes.clone(),
            specs: self.specs.clone(),
            supervisors: self.supervisors.clone(),
            child_parent: self.child_parent.clone(),
            monitors: self.monitors.clone(),
            delivered_down: self.delivered_down.clone(),
            links: self.links.clone(),
            runnable: self.runnable.clone(),
            high_priority_streak: self.high_priority_streak,
        }
    }

    /// Restores a validated snapshot without resetting budgets, authority, or
    /// restart intensity.
    pub fn restore(snapshot: KernelSnapshot) -> Result<Self, KernelError> {
        if snapshot.processes.len() > MAX_PROCESSES_PER_EXECUTION
            || snapshot.processes.values().any(|process| {
                !snapshot.specs.contains_key(&process.spec_id)
                    || process.mailbox.spec.validate().is_err()
            })
            || snapshot.supervisors.values().any(|supervisor| {
                supervisor
                    .children
                    .iter()
                    .any(|child| !snapshot.processes.contains_key(child))
            })
        {
            return Err(KernelError::InvalidSnapshot);
        }
        Ok(Self {
            logical_time: snapshot.logical_time,
            process_sequence: snapshot.process_sequence,
            processes: snapshot.processes,
            specs: snapshot.specs,
            supervisors: snapshot.supervisors,
            child_parent: snapshot.child_parent,
            monitors: snapshot.monitors,
            delivered_down: snapshot.delivered_down,
            links: snapshot.links,
            runnable: snapshot.runnable,
            high_priority_streak: snapshot.high_priority_streak,
        })
    }

    /// Deterministic digest over replay-relevant state. Capability refs are
    /// hashed as opaque identifiers; no host credential material exists here.
    #[must_use]
    pub fn state_digest(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"DKG-SUPERVISED-KERNEL-V1\0");
        hasher.update(self.logical_time.to_be_bytes());
        hasher.update(self.high_priority_streak.to_be_bytes());
        for (id, process) in &self.processes {
            hasher.update(id.0);
            hasher.update(process.epoch.to_be_bytes());
            hasher.update(process.spec_id.0);
            hasher.update(process.capability_ref.0);
            hasher.update((process.mailbox.len() as u64).to_be_bytes());
            hasher.update((process.mailbox.bytes() as u64).to_be_bytes());
            for (kind, account) in &process.budget.accounts {
                hasher.update([budget_tag(*kind)]);
                hasher.update(account.limit.to_be_bytes());
                hasher.update(account.consumed.to_be_bytes());
                hasher.update(account.reserved.to_be_bytes());
                hasher.update([u8::from(account.overdrawn)]);
            }
        }
        for (id, supervisor) in &self.supervisors {
            hasher.update(id.0);
            for restart in &supervisor.restart_history {
                hasher.update(restart.to_be_bytes());
            }
            hasher.update([u8::from(supervisor.escalated)]);
        }
        hasher.finalize().into()
    }

    fn supervise_termination(
        &mut self,
        process_id: ProcessId,
        reason: &TerminationReason,
    ) -> Result<Vec<LifecycleEvent>, KernelError> {
        let Some(supervisor_id) = self.child_parent.get(&process_id).copied() else {
            return Ok(Vec::new());
        };
        let spec_id = self.processes[&process_id].spec_id;
        let restart_class = self.specs[&spec_id].restart_class;
        if !eligible_for_restart(restart_class, reason) {
            return Ok(vec![LifecycleEvent::NotRestarted {
                process: process_id,
                reason: reason.clone(),
            }]);
        }
        let affected = {
            let supervisor = self
                .supervisors
                .get(&supervisor_id)
                .ok_or(KernelError::InvalidSupervisor)?;
            let failed_index = supervisor
                .children
                .iter()
                .position(|child| *child == process_id)
                .ok_or(KernelError::InvalidSupervisor)?;
            match supervisor.strategy {
                RestartStrategy::OneForOne => vec![process_id],
                RestartStrategy::RestForOne => supervisor.children[failed_index..].to_vec(),
                RestartStrategy::OneForAll => supervisor.children.clone(),
            }
        };
        let mut events = Vec::new();
        for affected_id in affected.iter().rev() {
            if *affected_id != process_id {
                let sibling = self
                    .processes
                    .get_mut(affected_id)
                    .ok_or(KernelError::InvalidSupervisor)?;
                sibling.epoch = sibling.epoch.saturating_add(1);
                sibling.status = ProcessStatus::Terminated(TerminationReason::Shutdown);
            }
        }
        for affected_id in affected {
            let affected_spec = self.processes[&affected_id].spec_id;
            if self.specs[&affected_spec].restart_class == RestartClass::Temporary {
                events.push(LifecycleEvent::NotRestarted {
                    process: affected_id,
                    reason: self.processes[&affected_id]
                        .status
                        .clone()
                        .into_termination()
                        .unwrap_or(TerminationReason::Shutdown),
                });
                continue;
            }
            if self.record_restart(supervisor_id)? {
                self.escalate_supervisor(supervisor_id, &mut events)?;
                break;
            }
            let process = self
                .processes
                .get_mut(&affected_id)
                .ok_or(KernelError::InvalidSupervisor)?;
            process.status = ProcessStatus::Runnable;
            let epoch = process.epoch;
            self.enqueue_runnable(affected_id, Priority::Lifecycle);
            events.push(LifecycleEvent::Restarted {
                process: affected_id,
                epoch,
            });
        }
        Ok(events)
    }

    fn record_restart(&mut self, supervisor_id: ProcessId) -> Result<bool, KernelError> {
        let supervisor = self
            .supervisors
            .get_mut(&supervisor_id)
            .ok_or(KernelError::InvalidSupervisor)?;
        let cutoff = self.logical_time.saturating_sub(supervisor.window_ms);
        while supervisor
            .restart_history
            .front()
            .is_some_and(|timestamp| *timestamp < cutoff)
        {
            supervisor.restart_history.pop_front();
        }
        supervisor.restart_history.push_back(self.logical_time);
        Ok(supervisor.restart_history.len() > usize::from(supervisor.max_restarts))
    }

    fn escalate_supervisor(
        &mut self,
        supervisor_id: ProcessId,
        events: &mut Vec<LifecycleEvent>,
    ) -> Result<(), KernelError> {
        let children = {
            let supervisor = self
                .supervisors
                .get_mut(&supervisor_id)
                .ok_or(KernelError::InvalidSupervisor)?;
            supervisor.escalated = true;
            supervisor.children.clone()
        };
        for child in children.into_iter().rev() {
            if let Some(process) = self.processes.get_mut(&child) {
                process.status = ProcessStatus::Terminated(TerminationReason::Shutdown);
            }
        }
        events.push(LifecycleEvent::SupervisorEscalated {
            supervisor: supervisor_id,
        });
        Ok(())
    }

    fn emit_monitor_events(
        &mut self,
        target: ProcessId,
        epoch: u64,
        reason: &TerminationReason,
        events: &mut Vec<LifecycleEvent>,
    ) {
        let monitors = self
            .monitors
            .iter()
            .filter(|monitor| monitor.target == target)
            .copied()
            .collect::<Vec<_>>();
        for monitor in monitors {
            if self
                .delivered_down
                .insert((monitor.reference, target, epoch))
            {
                events.push(LifecycleEvent::ProcessDown {
                    observer: monitor.source,
                    reference: monitor.reference,
                    target,
                    epoch,
                    reason: reason.clone(),
                });
            }
        }
    }

    fn emit_link_events(
        &mut self,
        source: ProcessId,
        reason: &TerminationReason,
        events: &mut Vec<LifecycleEvent>,
    ) {
        let links = self.links.get(&source).cloned().unwrap_or_default();
        for link in links {
            let propagate = match link.policy {
                LinkFailurePolicy::PropagateAbnormal => reason.abnormal(),
                LinkFailurePolicy::PropagateAny => true,
                LinkFailurePolicy::ObserveOnly => false,
            };
            if propagate {
                events.push(LifecycleEvent::LinkExit {
                    peer: link.peer,
                    from: source,
                    reason: reason.clone(),
                });
            }
        }
    }

    fn enqueue_runnable(&mut self, process: ProcessId, priority: Priority) {
        let queue = self.runnable.entry(priority).or_default();
        if !queue.contains(&process) {
            queue.push_back(process);
        }
    }

    fn next_runnable(&mut self) -> Option<(Priority, ProcessId)> {
        if self.high_priority_streak >= MAX_HIGH_PRIORITY_STREAK {
            for priority in [Priority::Evidence, Priority::Telemetry] {
                if let Some(process) = self.runnable.entry(priority).or_default().pop_front() {
                    self.high_priority_streak = 0;
                    return Some((priority, process));
                }
            }
        }
        for priority in [
            Priority::Control,
            Priority::Authority,
            Priority::Lifecycle,
            Priority::Evidence,
            Priority::Telemetry,
        ] {
            if let Some(process) = self.runnable.entry(priority).or_default().pop_front() {
                if priority <= Priority::Lifecycle {
                    self.high_priority_streak = self.high_priority_streak.saturating_add(1);
                } else {
                    self.high_priority_streak = 0;
                }
                return Some((priority, process));
            }
        }
        None
    }
}

trait IntoTermination {
    fn into_termination(self) -> Option<TerminationReason>;
}

impl IntoTermination for ProcessStatus {
    fn into_termination(self) -> Option<TerminationReason> {
        match self {
            Self::Terminated(reason) => Some(reason),
            _ => None,
        }
    }
}

fn eligible_for_restart(restart_class: RestartClass, reason: &TerminationReason) -> bool {
    if reason.restart_blocked() {
        return false;
    }
    match restart_class {
        RestartClass::Permanent => true,
        RestartClass::Transient => reason.abnormal(),
        RestartClass::Temporary => false,
    }
}

/// Produces a stable digest from a representative V1 supervision transition.
///
/// This is intentionally a test/conformance surface rather than a runtime
/// command. Native and Wasm builds execute this exact function so the host gate
/// detects target-specific drift in supervision, mailbox ordering, budgets,
/// restart handling, snapshot restoration, monitors, and links.
#[doc(hidden)]
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn supervised_kernel_conformance_vector() -> [u8; 32] {
    let process_id = |value| ProcessId::new([value; 32]);
    let child = |value, restart_class| {
        (
            process_id(value),
            ChildSpec {
                id: ChildSpecId::new([value; 32]),
                restart_class,
                mailbox: MailboxSpec {
                    schema_id: [7; 32],
                    schema_version: 1,
                    max_count: 4,
                    max_bytes: 1_024,
                    max_message_bytes: 256,
                    reserved_control_count: 1,
                    reserved_control_bytes: 128,
                    overflow: OverflowPolicy::Reject,
                },
                shutdown_timeout_ms: 100,
                capability_ref: CapabilityRef::new([value; 32]),
                budget_limits: BTreeMap::from([
                    (BudgetKind::Steps, 10),
                    (BudgetKind::ModelTokens, 1_000),
                    (BudgetKind::Restarts, 3),
                ]),
            },
        )
    };
    let message = |value, priority| MailboxMessage {
        id: MessageId::new([value; 32]),
        schema_id: [7; 32],
        schema_version: 1,
        payload: vec![value; 8],
        priority,
        coalesce_key: None,
        expires_at: None,
    };

    let mut kernel = SupervisedKernel::new(1_000);
    kernel
        .spawn_supervisor(
            process_id(90),
            RestartStrategy::RestForOne,
            4,
            60_000,
            vec![
                child(1, RestartClass::Transient),
                child(2, RestartClass::Permanent),
                child(3, RestartClass::Temporary),
            ],
        )
        .expect("conformance topology is valid");
    kernel
        .budget_mut(process_id(2))
        .expect("conformance child exists")
        .reserve(BudgetKind::ModelTokens, 500)
        .expect("conformance reservation fits");
    kernel
        .budget_mut(process_id(2))
        .expect("conformance child exists")
        .settle(BudgetKind::ModelTokens, 500, 450)
        .expect("conformance settlement matches");
    kernel
        .monitor(process_id(1), process_id(2), MonitorRef::new([8; 32]))
        .expect("conformance monitor is valid");
    kernel
        .link(
            process_id(1),
            process_id(2),
            LinkFailurePolicy::PropagateAbnormal,
        )
        .expect("conformance link is valid");
    kernel
        .send(process_id(1), message(11, Priority::Telemetry))
        .expect("conformance message is valid");
    kernel
        .send(process_id(1), message(12, Priority::Control))
        .expect("conformance message is valid");
    let scheduler = kernel.run_scheduler();
    let lifecycle = kernel
        .terminate(process_id(2), TerminationReason::ProtocolViolation)
        .expect("conformance termination is valid");
    let restored =
        SupervisedKernel::restore(kernel.snapshot()).expect("conformance snapshot is valid");

    let mut hasher = Sha256::new();
    hasher.update(b"DKG-SUPERVISED-KERNEL-CONFORMANCE-V1\0");
    hasher.update(restored.state_digest());
    hasher.update(scheduler.transitions.to_be_bytes());
    hasher.update(scheduler.activations.to_be_bytes());
    hasher.update(scheduler.host_commands.to_be_bytes());
    hasher.update([u8::from(scheduler.yielded)]);
    for (process, message) in scheduler.processed {
        hasher.update(process.0);
        hasher.update(message.0);
    }
    for event in lifecycle {
        match event {
            LifecycleEvent::Restarted { process, epoch } => {
                hasher.update([0]);
                hasher.update(process.0);
                hasher.update(epoch.to_be_bytes());
            }
            LifecycleEvent::NotRestarted { process, reason } => {
                hasher.update([1]);
                hasher.update(process.0);
                hash_termination_reason(&mut hasher, &reason);
            }
            LifecycleEvent::SupervisorEscalated { supervisor } => {
                hasher.update([2]);
                hasher.update(supervisor.0);
            }
            LifecycleEvent::ProcessDown {
                observer,
                reference,
                target,
                epoch,
                reason,
            } => {
                hasher.update([3]);
                hasher.update(observer.0);
                hasher.update(reference.0);
                hasher.update(target.0);
                hasher.update(epoch.to_be_bytes());
                hash_termination_reason(&mut hasher, &reason);
            }
            LifecycleEvent::LinkExit { peer, from, reason } => {
                hasher.update([4]);
                hasher.update(peer.0);
                hasher.update(from.0);
                hash_termination_reason(&mut hasher, &reason);
            }
        }
    }
    hasher.finalize().into()
}

fn hash_termination_reason(hasher: &mut Sha256, reason: &TerminationReason) {
    match reason {
        TerminationReason::NormalCompleted => hasher.update([0]),
        TerminationReason::Cancelled => hasher.update([1]),
        TerminationReason::Shutdown => hasher.update([2]),
        TerminationReason::Failure(code) => {
            hasher.update([3]);
            hasher.update((code.len() as u64).to_be_bytes());
            hasher.update(code.as_bytes());
        }
        TerminationReason::Timeout => hasher.update([4]),
        TerminationReason::ProtocolViolation => hasher.update([5]),
        TerminationReason::AuthorityRevoked => hasher.update([6]),
        TerminationReason::BudgetExhausted => hasher.update([7]),
        TerminationReason::NoProcess => hasher.update([8]),
    }
}

const fn budget_tag(kind: BudgetKind) -> u8 {
    match kind {
        BudgetKind::Steps => 0,
        BudgetKind::ModelTokens => 1,
        BudgetKind::ToolCalls => 2,
        BudgetKind::DkgQueries => 3,
        BudgetKind::Bytes => 4,
        BudgetKind::ChildProcesses => 5,
        BudgetKind::OutstandingCommands => 6,
        BudgetKind::Restarts => 7,
        BudgetKind::SpendMicros => 8,
    }
}

/// Stable kernel failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KernelError {
    /// Mailbox spec violated a V1 invariant.
    InvalidMailboxSpec,
    /// Supervisor declaration was invalid.
    InvalidSupervisor,
    /// Stable process/spec identity was reused.
    DuplicateIdentity,
    /// Process does not exist.
    ProcessNotFound,
    /// Process already terminated.
    ProcessTerminated,
    /// Explicit logical time moved backwards.
    LogicalTimeRegressed,
    /// Budget kind was not present in the plan.
    BudgetKindMissing,
    /// Remaining budget could not satisfy the reservation.
    BudgetExhausted,
    /// Result did not match the outstanding reservation.
    BudgetReservationMismatch,
    /// Snapshot violated a plan/runtime invariant.
    InvalidSnapshot,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process_id(value: u8) -> ProcessId {
        ProcessId::new([value; 32])
    }

    fn spec_id(value: u8) -> ChildSpecId {
        ChildSpecId::new([value; 32])
    }

    fn mailbox(policy: OverflowPolicy) -> MailboxSpec {
        MailboxSpec {
            schema_id: [7; 32],
            schema_version: 1,
            max_count: 3,
            max_bytes: 1_024,
            max_message_bytes: 256,
            reserved_control_count: 1,
            reserved_control_bytes: 128,
            overflow: policy,
        }
    }

    fn message(value: u8, priority: Priority, key: Option<&str>) -> MailboxMessage {
        MailboxMessage {
            id: MessageId::new([value; 32]),
            schema_id: [7; 32],
            schema_version: 1,
            payload: vec![value; 8],
            priority,
            coalesce_key: key.map(str::to_string),
            expires_at: None,
        }
    }

    fn child(value: u8, restart_class: RestartClass) -> (ProcessId, ChildSpec) {
        (
            process_id(value),
            ChildSpec {
                id: spec_id(value),
                restart_class,
                mailbox: mailbox(OverflowPolicy::Reject),
                shutdown_timeout_ms: 100,
                capability_ref: CapabilityRef::new([value; 32]),
                budget_limits: BTreeMap::from([(BudgetKind::Steps, 10), (BudgetKind::Restarts, 3)]),
            },
        )
    }

    #[test]
    fn mailbox_reserves_control_capacity_and_coalesces_deterministically() {
        let mut mailbox = BoundedMailbox::new(mailbox(OverflowPolicy::Coalesce)).unwrap();
        assert_eq!(
            mailbox.enqueue(message(1, Priority::Telemetry, Some("node-a"))),
            MailboxDecision::Enqueued,
        );
        assert_eq!(
            mailbox.enqueue(message(2, Priority::Telemetry, Some("node-b"))),
            MailboxDecision::Enqueued,
        );
        assert_eq!(
            mailbox.enqueue(message(3, Priority::Telemetry, Some("node-a"))),
            MailboxDecision::Coalesced,
        );
        assert_eq!(mailbox.len(), 2);
        assert_eq!(
            mailbox.enqueue(message(4, Priority::Control, None)),
            MailboxDecision::Enqueued,
        );
        assert_eq!(mailbox.pop().unwrap().id, MessageId::new([4; 32]));
    }

    #[test]
    fn budget_settlement_is_monotonic_and_overdrawn_usage_is_not_hidden() {
        let mut budget = BudgetLedger::new([(BudgetKind::ModelTokens, 100)]);
        budget.reserve(BudgetKind::ModelTokens, 40).unwrap();
        budget.settle(BudgetKind::ModelTokens, 40, 55).unwrap();
        let account = budget.account(BudgetKind::ModelTokens).unwrap();
        assert_eq!(account.consumed, 55);
        assert!(account.overdrawn);
        assert_eq!(
            budget.reserve(BudgetKind::ModelTokens, 1),
            Err(KernelError::BudgetExhausted),
        );
    }

    #[test]
    fn restart_strategies_preserve_budget_and_authority_and_skip_temporary_children() {
        let mut kernel = SupervisedKernel::new(10);
        kernel
            .spawn_supervisor(
                process_id(90),
                RestartStrategy::OneForAll,
                5,
                100,
                vec![
                    child(1, RestartClass::Transient),
                    child(2, RestartClass::Permanent),
                    child(3, RestartClass::Temporary),
                ],
            )
            .unwrap();
        kernel
            .budget_mut(process_id(1))
            .unwrap()
            .reserve(BudgetKind::Steps, 4)
            .unwrap();
        kernel
            .budget_mut(process_id(1))
            .unwrap()
            .settle(BudgetKind::Steps, 4, 4)
            .unwrap();
        let authority = kernel.process(process_id(1)).unwrap().capability_ref;
        let events = kernel
            .terminate(process_id(1), TerminationReason::Failure("boom".into()))
            .unwrap();
        assert!(events.iter().any(|event| matches!(event, LifecycleEvent::Restarted { process, .. } if *process == process_id(1))));
        assert!(events.iter().any(|event| matches!(event, LifecycleEvent::NotRestarted { process, .. } if *process == process_id(3))));
        assert_eq!(
            kernel
                .process(process_id(1))
                .unwrap()
                .budget
                .account(BudgetKind::Steps)
                .unwrap()
                .consumed,
            4,
        );
        assert_eq!(
            kernel.process(process_id(1)).unwrap().capability_ref,
            authority
        );
    }

    #[test]
    fn all_restart_classes_and_sibling_strategies_have_distinct_semantics() {
        for (strategy, expected) in [
            (RestartStrategy::OneForOne, vec![2]),
            (RestartStrategy::RestForOne, vec![2, 3]),
            (RestartStrategy::OneForAll, vec![1, 2, 3]),
        ] {
            let mut kernel = SupervisedKernel::new(10);
            kernel
                .spawn_supervisor(
                    process_id(90),
                    strategy,
                    10,
                    100,
                    vec![
                        child(1, RestartClass::Permanent),
                        child(2, RestartClass::Transient),
                        child(3, RestartClass::Permanent),
                    ],
                )
                .unwrap();
            let events = kernel
                .terminate(process_id(2), TerminationReason::Failure("boom".into()))
                .unwrap();
            let restarted = events
                .iter()
                .filter_map(|event| match event {
                    LifecycleEvent::Restarted { process, .. } => Some(process.bytes()[0]),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(restarted, expected);
        }

        let mut kernel = SupervisedKernel::new(10);
        kernel
            .spawn_supervisor(
                process_id(90),
                RestartStrategy::OneForOne,
                10,
                100,
                vec![
                    child(1, RestartClass::Permanent),
                    child(2, RestartClass::Transient),
                    child(3, RestartClass::Temporary),
                ],
            )
            .unwrap();
        assert!(
            kernel
                .terminate(process_id(1), TerminationReason::NormalCompleted)
                .unwrap()
                .iter()
                .any(|event| matches!(event, LifecycleEvent::Restarted { .. }))
        );
        assert!(
            kernel
                .terminate(process_id(2), TerminationReason::NormalCompleted)
                .unwrap()
                .iter()
                .all(|event| !matches!(event, LifecycleEvent::Restarted { .. }))
        );
        assert!(
            kernel
                .terminate(process_id(3), TerminationReason::Failure("boom".into()))
                .unwrap()
                .iter()
                .all(|event| !matches!(event, LifecycleEvent::Restarted { .. }))
        );
    }

    #[test]
    fn restart_intensity_persists_through_snapshot_and_escalates() {
        let mut kernel = SupervisedKernel::new(10);
        kernel
            .spawn_supervisor(
                process_id(90),
                RestartStrategy::OneForOne,
                1,
                100,
                vec![child(1, RestartClass::Permanent)],
            )
            .unwrap();
        kernel
            .terminate(process_id(1), TerminationReason::Failure("one".into()))
            .unwrap();
        let mut restored = SupervisedKernel::restore(kernel.snapshot()).unwrap();
        restored.advance_time(11).unwrap();
        let events = restored
            .terminate(process_id(1), TerminationReason::Failure("two".into()))
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| matches!(event, LifecycleEvent::SupervisorEscalated { .. }))
        );
    }

    #[test]
    fn monitor_deduplicates_and_links_carry_no_authority() {
        let mut kernel = SupervisedKernel::new(0);
        kernel
            .spawn_supervisor(
                process_id(90),
                RestartStrategy::OneForOne,
                3,
                100,
                vec![
                    child(1, RestartClass::Temporary),
                    child(2, RestartClass::Temporary),
                ],
            )
            .unwrap();
        let reference = MonitorRef::new([8; 32]);
        assert!(
            kernel
                .monitor(process_id(2), process_id(1), reference)
                .unwrap()
                .is_none()
        );
        assert!(
            kernel
                .monitor(process_id(2), process_id(1), reference)
                .unwrap()
                .is_none()
        );
        let left_authority = kernel.process(process_id(1)).unwrap().capability_ref;
        kernel
            .link(
                process_id(1),
                process_id(2),
                LinkFailurePolicy::PropagateAbnormal,
            )
            .unwrap();
        let events = kernel
            .terminate(process_id(1), TerminationReason::Failure("x".into()))
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, LifecycleEvent::ProcessDown { .. }))
                .count(),
            1
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, LifecycleEvent::LinkExit { .. }))
        );
        assert_eq!(
            kernel.process(process_id(1)).unwrap().capability_ref,
            left_authority
        );
    }

    #[test]
    fn scheduler_is_bounded_and_control_priority_wins() {
        let mut kernel = SupervisedKernel::new(0);
        kernel
            .spawn_supervisor(
                process_id(90),
                RestartStrategy::OneForOne,
                3,
                100,
                vec![child(1, RestartClass::Permanent)],
            )
            .unwrap();
        kernel
            .send(process_id(1), message(1, Priority::Telemetry, None))
            .unwrap();
        kernel
            .send(process_id(1), message(2, Priority::Control, None))
            .unwrap();
        let output = kernel.run_scheduler();
        assert_eq!(output.processed[0].1, MessageId::new([2; 32]));
        assert!(output.transitions <= MAX_TRANSITIONS_PER_APPLY);
        assert!(output.activations <= MAX_ACTIVATIONS_PER_APPLY);
    }
}
