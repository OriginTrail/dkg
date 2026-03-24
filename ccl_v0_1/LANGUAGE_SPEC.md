# CCL v0.1 Language Spec

## 1. Purpose

CCL is a deterministic language for evaluating **corroboration and consensus-adjacent conditions** over a fixed DKG snapshot.

It exists to solve a narrow problem:

- agents may publish claims, evidence links, contradictions, ownership declarations, quorum facts, epochs, and authority classes
- nodes need a replayable way to adjudicate whether some condition is satisfied
- the result must be identical on all honest nodes given the same inputs

CCL does **not** discover truth.
CCL does **not** mutate authoritative state directly.
CCL does **not** replace `PUBLISH`.

---

## 2. Evaluation context

Every CCL evaluation is scoped by a declared context:

- `paranet`
- `scope_ual`
- `view`
- `snapshot_id`
- `policy_name`
- `policy_version`

The evaluation boundary is closed. Only facts present in the declared snapshot/view are visible to the evaluator.

---

## 3. Core data model

Facts are normalized atoms:

```text
predicate(arg1, arg2, ..., argN)
```

Examples:

```text
claim(c1)
supports(e1, c1)
authority_class(e1, vendor)
evidence_view(e1, accepted)
owner_of(p1, 0xalice)
signed_by(p1, 0xalice)
quorum_reached(incident_review, 3, 4)
claim_epoch(c1, 7)
quorum_epoch(incident_review, 7)
contradicts(c2, c1)
accepted_status(c2, accepted)
```

In the canonical test package, facts are serialized as YAML tuples:

```yaml
- [supports, e1, c1]
- [authority_class, e1, vendor]
```

---

## 4. Outputs

CCL produces two output classes:

### 4.1 Derived predicates
Facts computed by rule evaluation.

Examples:

```text
corroborated(c1)
disputed(c2)
promotable(c1)
owner_asserted(p1)
```

### 4.2 Decisions
Named outputs intended to become **inputs to later publish flows**.

Examples:

```text
propose_accept(c1)
propose_reject(c2)
```

A CCL decision is **not authoritative state by itself**.

---

## 5. Determinism requirements

CCL v0.1 must remain safe on a distributed trustless network.

Therefore:

- no external API calls
- no hidden model calls
- no floating-point arithmetic
- no access to local wall clock
- no randomization
- no recursion
- no dynamic code loading
- no dependence on local DB iteration order

All facts, rule order, and output serialization must be canonicalized by the evaluator.

---

## 6. Language restrictions

CCL v0.1 is intentionally small.

### Allowed constructs
- positive atoms
- existential checks
- negated existential checks
- distinct counts with integer thresholds
- conjunction (`all`)
- references to previously derived predicates

### Disallowed constructs
- recursion
- unstratified negation
- unrestricted arithmetic
- user-defined functions
- fuzzy similarity
- regex / substring matching in the trustless core
- implicit type coercion

---

## 7. Canonical policy model

The reference evaluator uses a canonical YAML representation.

### Rule shape

```yaml
- name: corroborated
  params: [Claim]
  all:
    - atom: {pred: claim, args: ["$Claim"]}
    - count_distinct:
        vars: [Evidence]
        where:
          - atom: {pred: supports, args: ["$Evidence", "$Claim"]}
          - atom: {pred: evidence_view, args: ["$Evidence", "accepted"]}
          - atom: {pred: independent, args: ["$Evidence"]}
        op: ">="
        value: 2
```

### Decision shape

```yaml
- name: propose_accept
  params: [Claim]
  all:
    - atom: {pred: promotable, args: ["$Claim"]}
```

---

## 8. Semantics

### 8.1 Atom
An `atom` joins against either:
- base facts from the snapshot
- already derived predicates

Variables begin with `$`.

Use descriptive names such as `$Claim`, `$Evidence`, `$Agent`, or `$Epoch` in human-authored policies.

Example:

```yaml
atom: {pred: supports, args: ["$E", "$C"]}
```

### 8.2 Exists
`exists` succeeds if the nested `where` block has at least one satisfying assignment.

### 8.3 Not exists
`not_exists` succeeds if the nested `where` block has zero satisfying assignments.

### 8.4 Count distinct
`count_distinct` evaluates a nested `where` block, projects the named variables, counts distinct tuples, and applies an integer comparison.

Example:

```yaml
count_distinct:
  vars: [Evidence]
  where: ...
  op: ">="
  value: 2
```

### 8.5 Rule evaluation
Rules are evaluated until fixpoint over:
- base facts
- newly derived predicates

Since recursion is forbidden in v0.1, fixpoint convergence is bounded and straightforward.

### 8.6 Decision evaluation
Decisions are evaluated after rule derivation fixpoint.

---

## 9. Alignment with DKG v9 axioms

### A1. Paranet-scoped
CCL evaluation is explicitly paranet-scoped.

### A2. Authority-aware
Authority is represented as facts and checked by policy rules.

### A3. Typed transitions
CCL itself does not mutate state. Decisions can feed later typed transitions.

### A4. Canonical publish
CCL output is advisory until introduced via normal `PUBLISH`.

### A5. Workspace vs authoritative
View must be declared. Policies can intentionally count only `accepted` evidence and ignore `workspace`.

### A6. Declared state views
The snapshot/view boundary is first-class.

### A7. Explicit movement across layers
Promotion readiness can be derived, but actual promotion still requires explicit publish.

### A8. Deterministic conflict resolution
Accepted contradictions, epochs, and quorum facts are all explicit inputs to deterministic rules.

---

## 10. Recommended canonical serialization fields

A future canonical policy envelope should include:

- `policy_name`
- `policy_version`
- `paranet`
- `scope_ual`
- `view`
- `snapshot_id`
- `rule_hash`
- `fact_set_hash`
- `evaluator_version`

---

## 11. Non-goals

CCL v0.1 is not intended to:
- replace graph query languages
- replace application workflow engines
- represent arbitrary human legal logic
- do probabilistic reasoning
- do semantic entity resolution directly

Those can exist upstream as proposal-generating layers.

---

## 12. Suggested future extensions

- stratified disjunction
- typed enums / schemas
- signed policy envelopes
- canonical CBOR policy encoding
- proof trace compression
- explicit cost limits per rule
- static policy validator / linter
