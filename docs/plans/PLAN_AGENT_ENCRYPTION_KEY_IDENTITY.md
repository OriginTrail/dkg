# RFC: Agent Workspace-Encryption Key Identity (X25519)

**Status**: Proposed (RFC, no implementation yet)
**Date**: 2026-05
**Owners**: TBD (DKG agent + publisher folks)
**Discussion**: this document — PR comments welcome

> This RFC captures a design discussion that surfaced repeatedly during
> rc6 / rc7 testnet usage. It does **not** propose any code change yet.
> The intent is to align on the right long-term model before we land
> any of the candidate fixes (PR #508 surfaced the symptom but not the
> root cause).

---

## 1. Problem Statement

The publisher refuses to encrypt SWM payloads when the recipient
agent has more than one valid `publicEncryptionKey` triple in the
local triple store:

```218:233:packages/publisher/src/workspace-agent-recipients.ts
function verifyAgentEncryptionKeyProof(
  agentAddress: string,
  publicKeyBytes: Uint8Array,
  proof: string,
): boolean {
  try {
    const payload = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
    });
    const recovered = ethers.verifyMessage(payload, proof);
    return recovered.toLowerCase() === agentAddress.toLowerCase();
  } catch {
    return false;
  }
}
```

```197:200:packages/publisher/src/workspace-agent-recipients.ts
  if (validKeys.size > 1) {
    throw new Error(`Ambiguous public encryption keys for DKG agent ${checksum}`);
  }
```

This is the *security-correct* fail-closed behaviour — we can't tell
which key the recipient's currently-running daemon actually holds, so
we refuse to gamble. But the UX is brutal: a single promiscuous
multi-daemon agent on the network can deny `WM → SWM` promotion for
every CG they're a member of, indefinitely, with no obvious user-side
remediation other than removing the agent or hand-editing
`store.nq`.

We've now hit this twice in two weeks (different agents, same
underlying class of bug — see incident notes at the end), and there
isn't a clean "right now" answer that's both robust and respects the
threat model. Hence this RFC.

---

## 2. Background: how X25519 keys end up in the registry today

Each daemon, on first keystore initialisation, mints its own random
X25519 keypair:

```69:79:packages/core/src/crypto/workspace-encryption.ts
export function generateWorkspaceRecipientEncryptionKey(
  recipientId: string,
  recipientKeyId: string,
  randomBytes?: (length: number) => Uint8Array,
): WorkspaceRecipientEncryptionKey {
  assertNonEmpty('recipientId', recipientId);
  assertNonEmpty('recipientKeyId', recipientKeyId);
  const privateKeyBytes = checkedRandomBytes(
    WORKSPACE_X25519_KEY_BYTES,
    randomBytes ?? secureRandomBytes,
  );
```

The agent's EOA then signs an EIP-191 attestation over
`{agentAddress, "X25519", publicKey}` — that's the
`encryptionKeyProof` triple. Verification recovers the signer via
`ethers.verifyMessage` and checks it equals `agentAddress`.

Three distinct cryptosystems sit on top of the same "agent" identity:

| Layer | Key type | Where it lives | Used for |
|---|---|---|---|
| Agent address | secp256k1 (EOA) | `wallets.json` | On-chain identity, signs delegations, signs the X25519 attestation |
| Peer ID | ed25519 (libp2p) | `agent-key.bin` | Transport identity, libp2p auth, gossip |
| `publicEncryptionKey` | **X25519** (curve25519 ECDH) | `swm-sender-keys.json` (private key) + `store.nq` (public + attestation) | SWM payload sealing (X25519-HKDF-SHA256 → AEAD) |

**The duplication comes from the fact that the EOA-to-X25519
relationship is many-to-many by construction**: an EOA can sign a
valid attestation over *any* X25519 public key, and one EOA can run
N daemons, each minting its own X25519 keypair and getting a valid
attestation from the shared wallet. Nothing in the protocol marks
one of those as "the canonical one"; they accumulate in the global
`<did:dkg:context-graph:agents>` graph as they gossip in from peers.

The `prov#atTime` registration timestamps that *are* in the store
are stamped on the activity subject
(`did:dkg:agent:<addr>/.well-known/genid/registration`) — they
record "the agent registered itself at time T", but they're **not
linked to a specific key triple**, so we can't even use them to pick
"the most recent key". The registry is structurally lossy here.

---

## 3. Threat model

The X25519 key is the **recipient's static** half of an
X25519-HKDF-SHA256 sealed envelope. The sender uses a fresh
ephemeral X25519 per message (so the sender side has forward
secrecy), but the recipient side does not — anyone who learns a
recipient's X25519 private key can decrypt every SWM envelope ever
addressed to that key, anywhere they can lay hands on one (network
capture, peer store, backup, etc.). That's the standard property of
sealed-box schemes; not unique to DKG.

The relevant threat-model question for this RFC is:

> If an agent registers N valid X25519 keys (one per daemon), what
> additional risk does that expose, relative to the single-key case?

| | One key | N valid keys |
|---|---|---|
| Surface to read SWM addressed to this agent | Compromise the one keystore | Compromise *any* of the N keystores |
| Retired-but-not-erased keystores | Doesn't arise | Old keys remain decrypters until protocol-level revocation |
| Forward secrecy on the recipient side | Already absent for sealed-box | Already absent — no regression in property, just in surface area |
| Plaintext blast radius | Local store, encrypted under separate key (`private-store.key`) | Same — the X25519 key only unseals envelopes |

The blast radius isn't a single message — it's "every SWM envelope
this agent has ever been a recipient on, that the attacker can lay
hands on later, *for the lifetime of the leaked X25519 key*".

In practice the threat is largely benign: if a user runs multiple
daemons of their own wallet, all those keystores are theirs; if one
leaks, the EOA wallet next to it on disk has probably also leaked,
at which point everything is gone anyway.

What's clearly **worse than "encrypt to all valid keys"** is the
current behaviour: fail closed on the publisher and block every
honest `WM → SWM` promote until someone manually un-tangles the
registry. That's "secure" in the formal sense but it's not safer in
any meaningful threat-model way — it just denies service.

---

## 4. Candidate designs

Four options surfaced in the rc7-test discussion. They are not
mutually exclusive.

### Option 1 — Deterministic X25519 derivation from EOA

Derive the X25519 keypair from the EOA private key using a fixed
KDF, e.g.:

```
x25519_priv = clamp(HKDF-Expand(
  HKDF-Extract(salt = "dkg/agent-x25519/v1", ikm = eoaPrivateKey),
  info = utf8(agentAddress),
  L = 32,
))
```

Any daemon that has the wallet derives the same X25519 key. One EOA
→ one canonical encryption identity, by construction. The
duplicate class is eliminated entirely; the attestation can either
be dropped or kept as a tamper check.

**Security argument**: anyone with EOA-level access can already
speak as the agent — sign delegations, issue invites, transfer
on-chain assets. Granting them the ability to derive the X25519 key
is the same trust level. We're not enlarging the EOA's privileges,
we're just observing that "decrypts SWM addressed to this EOA" is
already implied by EOA possession.

**Pros**

- Eliminates ambiguity completely for the EOA-agent case.
- No protocol-level "revocation" needed — there's nothing to revoke,
  because every daemon arrives at the same key.
- Backwards-compatible upgrade path: existing random X25519 keys
  stay valid until next regeneration; on next keystore init or
  re-key, the daemon derives the canonical key, registers it, and
  retires the random one.

**Cons**

- **Hardcodes the assumption that the agent identity is an EOA**
  (see Option 1 / contract-managed-agent caveat below).
- Loses any "compromise this one daemon doesn't compromise that
  one" property — but as argued in §3, that property was never
  meaningful given shared-EOA semantics.
- Requires a one-time on-network migration: existing duplicate keys
  need to be pruned eventually.

**Contract-managed agents (Safe, ERC-4337, etc.)**: this is where
Option 1 starts to leak. Contract addresses have no private scalar
to derive from. Two sub-variants:

- **1a — operator-EOA indirection**: derive X25519 from the
  designated operator EOA (the one that today signs EIP-191
  attestations on behalf of the contract). When the contract
  rotates its operator, the X25519 key rotates, registry needs to
  track that. Requires a key-rotation protocol the system doesn't
  have today.
- **1b — ERC-1271 attestation generalised**: keep random X25519 per
  daemon, but extend `verifyAgentEncryptionKeyProof` to do a
  staticcall to `isValidSignature(...)` when the agent address is a
  contract. This loses Option 1's "deterministic" property and
  collapses back into the multi-key problem for the
  contract-managed case — the contract can attest to multiple X25519
  keys just as freely as an EOA can.

So Option 1 is the cleanest answer **only for the EOA majority
case**; the contract-managed case needs a separate story. See §6
for migration sequencing.

### Option 2 — Encrypt to all valid keys

Keep the per-daemon random X25519 model unchanged. When the
publisher encounters multiple validly-attested keys for an agent,
emit one envelope per key inside the same recipient list. The
recipient's daemon only needs to decrypt the envelope matching its
own static key.

**Pros**

- Identity-model-agnostic: works for EOA agents and
  contract-managed agents identically — the publisher just trusts
  whatever attestations passed verification.
- Smallest possible diff: a handful of lines in
  `workspace-agent-recipients.ts` to switch from "pick one or
  throw" to "return all valid recipients".
- Ships *today*; no protocol changes, no key rotation, no migration.
- Robust to multi-daemon-per-EOA use cases by design.

**Cons**

- Expands the recipient list size when stale registrations
  accumulate. Per-envelope overhead is small (one ephemeral pubkey +
  one wrap of the AEAD key per recipient ≈ 80 bytes), but in the
  worst case a heavily-promiscuous EOA could push the recipient list
  to dozens of entries.
- "Revocation" remains an unsolved problem: a leaked old keystore
  keeps being able to decrypt new SWM until the corresponding
  registration is pruned. We'd want a protocol-level revoke
  mechanism eventually — out of scope for the initial change.
- Slightly worse forward-secrecy *surface area*, in the
  multi-daemon-per-EOA case, but no worse than the implicit
  semantics of "anyone with the wallet can decrypt".

### Option 3 — Prune-on-write (daemon self-hygiene)

When the daemon registers its own profile, `DELETE` prior
`publicEncryptionKey` / `encryptionKeyProof` /
`encryptionKeyAlgorithm` triples for its own subject in its local
data graph before inserting the new ones, and gossip the deletion
along with the insertion.

**Pros**

- Stops a single daemon from accumulating its *own* duplicates
  after a key regen (e.g. fresh `agent-keystore.json` on the same
  EOA).
- Localised change, low risk.
- Useful alongside Option 1 or Option 2, not as a standalone fix.

**Cons**

- Doesn't help with **gossiped-in duplicates from other daemons of
  the same EOA**, which is the case that has actually hit us. Two
  laptops both running daemons for the same wallet will both
  honestly insist their own attestation is the "current" one.
- Doesn't help the on-network historical accumulation.

### Option 4 — Revocation protocol

Introduce an explicit RDF predicate (e.g.
`dkg:revokedEncryptionKey`) or a signed envelope
(`AgentEncryptionKeyRevocation`) that the EOA can publish to
invalidate a specific X25519 public key. The publisher's resolver
filters revoked keys out.

**Pros**

- Cleanly handles "old laptop's daemon was lost / sold /
  compromised, retire its X25519 attestation".
- Composes with Options 1 / 2.

**Cons**

- Requires an additional verified write path on the publisher side
  (an EOA-signed revocation message), plus consensus on the
  predicate.
- Garbage-collecting revoked keys from peer stores is a separate
  problem.
- Marginal benefit if Option 1 lands — there's nothing to revoke
  when there's only one canonical key.

---

## 5. Recommendation

Stage the work in three steps:

1. **Land Option 2 first** (immediate). It's the only option that
   actually unblocks the UX symptom today, and it does so without
   committing to an identity model. Carries an obvious "revocation
   is unsolved" caveat that Option 4 can address later.
2. **Adopt Option 1 (EOA deterministic derivation)** as the
   canonical scheme for EOA agents. Roll out via a
   keystore-regeneration path: existing daemons keep working with
   their random X25519 keys; new keystores (or explicit re-keys)
   produce the deterministic key. Over a release or two the
   on-network duplicates fade as agents regen.
3. **Decide the contract-managed-agent story** as a follow-up RFC.
   Likely 1a (operator-EOA indirection with rotation events) plus
   Option 4 (revocation) layered on top. Don't try to design this
   inside the present RFC; deferring it doesn't block Option 2 or
   Option 1.

Option 3 (prune-on-write) is cheap hygiene and worth doing
alongside Option 1 to stop *new* duplicates from being written by
the daemon's own register path. Skip it if Option 1 ships first;
it becomes redundant.

---

## 6. Open questions

- How does the migration from random → deterministic X25519
  interact with currently-running daemons that have already gossiped
  their random key? Do we treat the deterministic key as having
  precedence the moment it's seen, or do we wait for the random
  registration to age out?
- For Option 2, should we cap the recipient-list size per agent
  (defensive bound against pathological accumulation)?
- For Option 1, do we want the X25519 attestation triple at all
  once derivation is deterministic? It's still useful as a
  tamper-check ("yes, this X25519 key really does correspond to
  this EOA"), but it's strictly redundant if any peer can re-derive
  from a known-good EOA root. Suggest: keep the attestation, since
  the registry consumer can't always reach the EOA's authorising
  signature otherwise.
- Should the X25519 key be agent-address-scoped (`info =
  agentAddress`) or fully wallet-scoped? Agent-address-scoped means
  one EOA controlling N agent addresses (via deterministic
  sub-accounts) gets N independent X25519 keys.

---

## 7. Background incidents

Two incidents made this RFC necessary:

1. **eems (~2026-05-12)**: Wallet `0xd46E77003d74df9aAdF011A5115A72405b084a88`
   appeared in two CG allowed-agent sets. The owner runs two
   daemons (`eems` and `codex-isolated-edge`) under the same EOA.
   Each daemon honestly registered its own X25519 attestation. The
   publisher fail-closed and blocked SWM promotion in every CG eems
   was a member of.
2. **Arx (~2026-05-14)**: Wallet `0xE5B88968Ed464F4e3f5354C54DFAB9e39dfEAfBd`
   in `rc7-test`. Same shape — two daemons, two valid X25519
   attestations. Compounded by the joiner's daemon being on a
   stale `ContextGraphsHub` config (separately fixed by PR #508 on
   the UI side), so even picking the right key wouldn't have
   delivered SWM that the recipient could decrypt. Working around
   it required the curator to call `remove-participant` to drop
   the agent from the allowlist entirely.

Both incidents pointed at the same root cause: the
EOA-to-X25519 binding is many-to-many, and we don't have a
mechanism to disambiguate.
