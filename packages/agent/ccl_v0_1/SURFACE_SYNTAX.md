# CCL v0.1 Surface Syntax

The package uses canonical YAML for machine evaluation.

This document defines a **human-oriented surface syntax** that can compile into that canonical form.

The surface syntax is intentionally small.

---

## 1. Example

```ccl
policy context_corroboration v0.1.0

rule corroborated(Claim):
  claim(Claim)
  count_distinct Evidence where
    supports(Evidence, Claim)
    evidence_view(Evidence, accepted)
    independent(Evidence)
  >= 2
  exists Evidence where
    supports(Evidence, Claim)
    evidence_view(Evidence, accepted)
    authority_class(Evidence, vendor)
  not exists Contradiction where
    contradicts(Contradiction, Claim)
    accepted_status(Contradiction, accepted)

rule disputed(Claim):
  claim(Claim)
  exists Contradiction where
    contradicts(Contradiction, Claim)
    accepted_status(Contradiction, accepted)

rule promotable(Claim):
  corroborated(Claim)
  claim_epoch(Claim, Epoch)
  quorum_epoch(incident_review, Epoch)
  quorum_reached(incident_review, 3, 4)

decision propose_accept(Claim):
  promotable(Claim)

decision propose_reject(Claim):
  disputed(Claim)
```

---

## 2. Design notes

### Variables
- Uppercase identifiers are variables: `Claim`, `Evidence`, `Agent`
- Lowercase identifiers are predicate names or constants: `claim`, `accepted`, `vendor`

### Rule heads
A rule head defines a derived predicate:

```ccl
rule corroborated(Claim):
```

### Decisions
A decision head defines a named output that may later feed a normal publish flow:

```ccl
decision propose_accept(Claim):
```

### Condition blocks
The rule body is conjunction-only in v0.1.
Every listed condition must hold.

### Exists
```ccl
exists Evidence where
  supports(Evidence, Claim)
  authority_class(Evidence, vendor)
```

### Not exists
```ccl
not exists Contradiction where
  contradicts(Contradiction, Claim)
  accepted_status(Contradiction, accepted)
```

### Count distinct
```ccl
count_distinct Evidence where
  supports(Evidence, Claim)
  independent(Evidence)
>= 2
```

---

## 3. Compilation target

A surface rule compiles into canonical YAML.

Example:

```ccl
rule owner_asserted(Claim):
  claim(Claim)
  exists Agent where
    owner_of(Claim, Agent)
    signed_by(Claim, Agent)
```

Compiles conceptually to:

```yaml
- name: owner_asserted
  params: [Claim]
  all:
    - atom: {pred: claim, args: ["$Claim"]}
    - exists:
        vars: [Agent]
        where:
          - atom: {pred: owner_of, args: ["$Claim", "$Agent"]}
          - atom: {pred: signed_by, args: ["$Claim", "$Agent"]}
```

---

## 4. Why canonical YAML exists

A trustless network needs:

- stable hashing
- stable ordering
- simple validation
- easy replay
- low parser ambiguity

So the surface syntax is ergonomics.  
The canonical form is what nodes should actually hash, store, sign, and evaluate.
