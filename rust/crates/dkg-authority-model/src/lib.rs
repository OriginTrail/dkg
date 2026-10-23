//! Pure capability attenuation rules. Credential custody remains host-owned.

use dkg_runtime_types::{CapabilityId, ExecutionId, LogicalTime};

/// Bitset of host-registered verbs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerbSet(pub u64);

impl VerbSet {
    /// Returns true when `requested` does not add a verb.
    #[must_use]
    pub const fn contains(self, requested: Self) -> bool {
        self.0 & requested.0 == requested.0
    }
}

/// Monotonic budget dimensions modelled in the kernel.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityBudget {
    /// Maximum protected calls.
    pub calls: u32,
    /// Maximum spend in integer micro-units.
    pub spending_microunits: u64,
}

impl CapabilityBudget {
    const fn contains(self, requested: Self) -> bool {
        self.calls >= requested.calls && self.spending_microunits >= requested.spending_microunits
    }
}

/// Non-secret capability metadata safe to reference from kernel state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityGrant {
    /// Grant identity; never a bearer token.
    pub id: CapabilityId,
    /// Execution to which the grant is bound.
    pub execution_id: ExecutionId,
    /// Allowed host-registered verbs.
    pub verbs: VerbSet,
    /// Canonical resource prefix; child prefixes must stay beneath it.
    pub resource_prefix: String,
    /// Grant expiry in logical event time.
    pub expires_at: LogicalTime,
    /// Grant start in logical event time.
    pub not_before: LogicalTime,
    /// Pinned host policy epoch.
    pub policy_epoch: u64,
    /// Remaining delegable budget ceiling.
    pub budget: CapabilityBudget,
    /// Remaining delegation depth.
    pub delegation_depth: u8,
    /// A one-shot parent cannot become reusable.
    pub one_shot: bool,
}

/// Requested child capability dimensions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttenuationRequest {
    /// Child grant identity supplied by the host.
    pub id: CapabilityId,
    /// Child execution binding.
    pub execution_id: ExecutionId,
    /// Requested verbs.
    pub verbs: VerbSet,
    /// Requested resource prefix.
    pub resource_prefix: String,
    /// Requested expiry.
    pub expires_at: LogicalTime,
    /// Requested start.
    pub not_before: LogicalTime,
    /// Requested policy epoch; delegation cannot silently repin policy.
    pub policy_epoch: u64,
    /// Requested budget ceiling.
    pub budget: CapabilityBudget,
    /// Whether the child is one-shot.
    pub one_shot: bool,
}

/// Stable attenuation failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttenuationError {
    /// Requested verbs exceed the parent.
    VerbsWidened,
    /// Requested resource is outside the parent's canonical prefix.
    ResourceWidened,
    /// Requested expiry exceeds the parent.
    ExpiryWidened,
    /// Requested start precedes the parent.
    NotBeforeWidened,
    /// Requested policy epoch differs from the parent.
    PolicyEpochChanged,
    /// Requested budget exceeds the parent.
    BudgetWidened,
    /// The parent cannot delegate any further.
    DelegationDepthExhausted,
    /// A one-shot parent was made reusable.
    OneShotWidened,
}

/// Produces a child grant only when every authority dimension narrows or stays
/// equal. Execution ancestry is host-validated before this pure rule is called.
pub fn attenuate(
    parent: &CapabilityGrant,
    request: AttenuationRequest,
) -> Result<CapabilityGrant, AttenuationError> {
    if !parent.verbs.contains(request.verbs) {
        return Err(AttenuationError::VerbsWidened);
    }
    if !resource_is_within(&parent.resource_prefix, &request.resource_prefix) {
        return Err(AttenuationError::ResourceWidened);
    }
    if request.expires_at > parent.expires_at {
        return Err(AttenuationError::ExpiryWidened);
    }
    if request.not_before < parent.not_before {
        return Err(AttenuationError::NotBeforeWidened);
    }
    if request.policy_epoch != parent.policy_epoch {
        return Err(AttenuationError::PolicyEpochChanged);
    }
    if !parent.budget.contains(request.budget) {
        return Err(AttenuationError::BudgetWidened);
    }
    if parent.delegation_depth == 0 {
        return Err(AttenuationError::DelegationDepthExhausted);
    }
    if parent.one_shot && !request.one_shot {
        return Err(AttenuationError::OneShotWidened);
    }
    Ok(CapabilityGrant {
        id: request.id,
        execution_id: request.execution_id,
        verbs: request.verbs,
        resource_prefix: request.resource_prefix,
        expires_at: request.expires_at,
        not_before: request.not_before,
        policy_epoch: request.policy_epoch,
        budget: request.budget,
        delegation_depth: parent.delegation_depth - 1,
        one_shot: request.one_shot,
    })
}

fn resource_is_within(parent: &str, child: &str) -> bool {
    child == parent
        || child
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn parent() -> CapabilityGrant {
        CapabilityGrant {
            id: CapabilityId::new(id(1)),
            execution_id: ExecutionId::new(id(2)),
            verbs: VerbSet(0b111),
            resource_prefix: "dkg/network/mainnet".into(),
            expires_at: LogicalTime(100),
            not_before: LogicalTime(10),
            policy_epoch: 7,
            budget: CapabilityBudget {
                calls: 10,
                spending_microunits: 1_000,
            },
            delegation_depth: 2,
            one_shot: true,
        }
    }

    #[test]
    fn accepted_child_is_strictly_attenuated() {
        let child = attenuate(
            &parent(),
            AttenuationRequest {
                id: CapabilityId::new(id(3)),
                execution_id: ExecutionId::new(id(4)),
                verbs: VerbSet(0b011),
                resource_prefix: "dkg/network/mainnet/node-1".into(),
                expires_at: LogicalTime(90),
                not_before: LogicalTime(20),
                policy_epoch: 7,
                budget: CapabilityBudget {
                    calls: 3,
                    spending_microunits: 100,
                },
                one_shot: true,
            },
        )
        .expect("narrow child");
        assert_eq!(child.delegation_depth, 1);
        assert_eq!(child.resource_prefix, "dkg/network/mainnet/node-1");
    }

    #[test]
    fn sibling_prefix_and_reusable_child_are_rejected() {
        let mut request = AttenuationRequest {
            id: CapabilityId::new(id(3)),
            execution_id: ExecutionId::new(id(4)),
            verbs: VerbSet(1),
            resource_prefix: "dkg/network/mainnet-other".into(),
            expires_at: LogicalTime(90),
            not_before: LogicalTime(20),
            policy_epoch: 7,
            budget: CapabilityBudget {
                calls: 1,
                spending_microunits: 1,
            },
            one_shot: true,
        };
        assert_eq!(
            attenuate(&parent(), request.clone()),
            Err(AttenuationError::ResourceWidened)
        );
        request.resource_prefix = "dkg/network/mainnet".into();
        request.one_shot = false;
        assert_eq!(
            attenuate(&parent(), request),
            Err(AttenuationError::OneShotWidened)
        );
    }

    #[test]
    fn accepted_generated_requests_never_widen_any_dimension() {
        let parent = parent();
        for verbs in 0..=0b1111 {
            for calls in [0, 1, 10, 11] {
                for spending in [0, 1, 1_000, 1_001] {
                    for not_before in [0, 10, 50] {
                        for expires_at in [50, 100, 101] {
                            for policy_epoch in [6, 7, 8] {
                                let request = AttenuationRequest {
                                    id: CapabilityId::new(id(3)),
                                    execution_id: ExecutionId::new(id(4)),
                                    verbs: VerbSet(verbs),
                                    resource_prefix: "dkg/network/mainnet/node-1".into(),
                                    expires_at: LogicalTime(expires_at),
                                    not_before: LogicalTime(not_before),
                                    policy_epoch,
                                    budget: CapabilityBudget {
                                        calls,
                                        spending_microunits: spending,
                                    },
                                    one_shot: true,
                                };
                                if let Ok(child) = attenuate(&parent, request) {
                                    assert!(parent.verbs.contains(child.verbs));
                                    assert!(resource_is_within(
                                        &parent.resource_prefix,
                                        &child.resource_prefix
                                    ));
                                    assert!(child.not_before >= parent.not_before);
                                    assert!(child.expires_at <= parent.expires_at);
                                    assert_eq!(child.policy_epoch, parent.policy_epoch);
                                    assert!(parent.budget.contains(child.budget));
                                    assert!(child.delegation_depth < parent.delegation_depth);
                                    assert!(child.one_shot);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
