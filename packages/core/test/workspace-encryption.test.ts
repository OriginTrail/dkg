import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
  ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
  ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
  WORKSPACE_ENCRYPTION_KEY_BYTES,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  assertSupportedEncryptedWorkspaceEnvelope,
  decodeWorkspaceEncryptionKey,
  decryptWorkspacePayload,
  encodeWorkspaceEncryptionKey,
  encryptWorkspacePayload,
  generateWorkspaceRecipientEncryptionKey,
  type EncryptWorkspacePayloadInput,
  type WorkspaceRecipientEncryptionKey,
} from '../src/index.js';

const textEncoder = new TextEncoder();

function deterministicRandomBytes(): (length: number) => Uint8Array {
  let next = 1;
  return (length: number) => new Uint8Array(length).fill(next++);
}

function recipientKey(
  recipientId: string,
  recipientKeyId: string,
  fill: number,
): WorkspaceRecipientEncryptionKey {
  return generateWorkspaceRecipientEncryptionKey(
    recipientId,
    recipientKeyId,
    (length) => new Uint8Array(length).fill(fill),
  );
}

function inputFor(recipients: WorkspaceRecipientEncryptionKey[]): EncryptWorkspacePayloadInput {
  return {
    contextGraphId: 'cg-private',
    senderIdentity: 'did:dkg:agent:0x1234',
    operationId: 'op-1',
    shareOperationId: 'swm-op-1',
    timestampMs: 1_770_000_000_000,
    subGraphName: 'chat',
    plaintext: textEncoder.encode('<urn:s> <urn:p> "secret" .'),
    recipients,
    randomBytes: deterministicRandomBytes(),
  };
}

describe('workspace encrypted payload helpers', () => {
  it('encrypts and decrypts workspace payloads for matching recipient encryption keys', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const bob = recipientKey('did:dkg:agent:bob', 'bob-key-1', 0xb1);
    const envelope = await encryptWorkspacePayload(inputFor([alice, bob]));

    expect(envelope.version).toBe(ENCRYPTED_WORKSPACE_ENVELOPE_VERSION);
    expect(envelope.type).toBe(ENCRYPTED_WORKSPACE_ENVELOPE_TYPE);
    expect(envelope.cipherAlgorithm).toBe(ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM);
    expect(envelope.keyAgreementAlgorithm).toBe(ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM);
    expect(envelope.ephemeralPublicKey).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
    expect(envelope.recipients).toHaveLength(2);
    expect(envelope.recipients[0].algorithm).toBe(ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM);
    expect(envelope.ciphertext).not.toEqual(inputFor([alice]).plaintext);

    const decrypted = await decryptWorkspacePayload(envelope, [bob]);
    expect(decrypted.recipientId).toBe(bob.recipientId);
    expect(decrypted.recipientKeyId).toBe(bob.recipientKeyId);
    expect(new Uint8Array(decrypted.plaintext)).toEqual(inputFor([alice]).plaintext);
  });

  it('decrypts a multi-key recipient envelope when the holder only owns one of the slots', async () => {
    // Mid-rotation: Bob has two registered keys; this node only holds the
    // private half of key 2. The sender wraps the content key under BOTH of
    // Bob's recipient slots. Decryption MUST succeed with just key 2.
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const bobOld = recipientKey('did:dkg:agent:bob', 'bob-key-1', 0xb1);
    const bobNew = recipientKey('did:dkg:agent:bob', 'bob-key-2', 0xb2);
    const envelope = await encryptWorkspacePayload(inputFor([alice, bobOld, bobNew]));
    expect(envelope.recipients).toHaveLength(3);

    // Drop the private half of the OLD key (simulating a node that only has
    // the freshly-rotated one). Decryption must still resolve via the NEW slot.
    const bobNewPrivKeyOnly: WorkspaceRecipientEncryptionKey = {
      ...bobNew,
    };
    const decrypted = await decryptWorkspacePayload(envelope, [bobNewPrivKeyOnly]);
    expect(decrypted.recipientKeyId).toBe(bobNew.recipientKeyId);
    expect(new Uint8Array(decrypted.plaintext)).toEqual(inputFor([alice]).plaintext);
  });

  it('rejects unsupported envelope type and version if JavaScript callers pass extra fields', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const unsupportedVersion = {
      ...inputFor([alice]),
      version: '2',
    } as EncryptWorkspacePayloadInput & { version: string };
    const unsupportedType = {
      ...inputFor([alice]),
      type: 'dkg.workspace.future',
    } as EncryptWorkspacePayloadInput & { type: string };

    await expect(encryptWorkspacePayload(unsupportedVersion)).rejects.toThrow(
      'Unsupported encrypted workspace envelope version',
    );
    await expect(encryptWorkspacePayload(unsupportedType)).rejects.toThrow(
      'Unsupported encrypted workspace envelope type',
    );
  });

  it('rejects unsupported encrypted workspace envelope constants before decryption', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const envelope = await encryptWorkspacePayload(inputFor([alice]));

    expect(() => assertSupportedEncryptedWorkspaceEnvelope({ ...envelope, version: '2' })).toThrow(
      'Unsupported encrypted workspace envelope version',
    );
    await expect(decryptWorkspacePayload({ ...envelope, type: 'other' }, [alice])).rejects.toThrow(
      'Unsupported encrypted workspace envelope type',
    );
  });

  it('rejects keys that are not dedicated workspace recipient encryption keys', async () => {
    const wrongPurpose = {
      ...recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1),
      purpose: 'ethereum.signing-key',
    } as WorkspaceRecipientEncryptionKey;

    await expect(encryptWorkspacePayload(inputFor([wrongPurpose]))).rejects.toThrow(
      'Expected a dedicated workspace recipient encryption key',
    );
  });

  it('fails closed when metadata bound into AAD is tampered', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const envelope = await encryptWorkspacePayload(inputFor([alice]));

    await expect(
      decryptWorkspacePayload({ ...envelope, contextGraphId: 'cg-other' }, [alice]),
    ).rejects.toThrow('No matching recipient encryption key could decrypt workspace payload');
  });

  it('does not decrypt with a non-matching recipient key', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const mallory = recipientKey('did:dkg:agent:mallory', 'mallory-key-1', 0xa1);
    const envelope = await encryptWorkspacePayload(inputFor([alice]));

    await expect(decryptWorkspacePayload(envelope, [mallory])).rejects.toThrow(
      'No matching recipient encryption key could decrypt workspace payload',
    );
  });

  it('generates dedicated recipient encryption keys with the expected size and purpose', () => {
    const key = generateWorkspaceRecipientEncryptionKey('did:dkg:agent:alice', 'alice-key-1');

    expect(key.purpose).toBe(WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE);
    expect(key.recipientId).toBe('did:dkg:agent:alice');
    expect(key.recipientKeyId).toBe('alice-key-1');
    expect(key.publicKeyBytes).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
    expect(key.privateKeyBytes).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
  });

  // Regression: PR #792 (CI shard `Tornado: agent [7/10]`,
  // test/ack-eip191-agent-extra.test.ts > "tampered signature does NOT
  // recover the agent address") flaked at ~0.02% with
  // `workspaceEncryptionKey must be 32 bytes` in
  // `mintCustodialWorkspaceEncryptionKey → signWorkspaceEncryptionKey →
  // decodeWorkspaceEncryptionKey`.
  //
  // Root cause: `encodeWorkspaceEncryptionKey` emits base64url. The
  // base64url alphabet (`[A-Za-z0-9_-]`) overlaps with hex
  // (`[0-9a-fA-F]` after `0x`) — every ~5,000th randomly-generated
  // 32-byte x25519 public key encodes to a base64url string whose first
  // two characters are `0x` (e.g.
  // `0xbT0xAeVsXZ3f7alN53CypTY2D4ejqY6CJlfEg2Yws`). The original
  // `decodeWorkspaceEncryptionKey` heuristic
  // `raw.startsWith('0x') ? hex : base64` then mis-routed those keys
  // to the hex branch — Buffer.from('bT0…', 'hex') silently truncates
  // at the first non-hex char, producing fewer than 32 bytes and
  // tripping the assertion.
  //
  // The round-5 fix narrowed the hex branch to "exactly `0x` + 64 hex
  // chars". Round 6+7 went further: the bot caught that `0x` + 41 'a'
  // chars (length 43) is a valid base64url string AND a plausible
  // mistype of canonical 64-char hex. There is no heuristic that
  // disambiguates the two without breaking the other edge. The final
  // resolution is to drop hex support from the decoder entirely (no
  // caller produces hex via this API anyway), so all `0x…` strings
  // unambiguously decode as base64url.
  it('encode → decode round-trip is byte-stable across many random x25519 keys', () => {
    // Deterministic background coverage. The base64url-with-0x-prefix
    // collision the next test pins is rare (~1/4096 per key) so an
    // expectation that 10k samples contain ≥1 collision flakes at ~8%
    // on its own; that flaky assertion was removed in favour of the
    // deterministic literal fixture below. This test still exercises
    // round-trip stability for 1k random keys, which is fast and gives
    // the byte-equality assertion broad coverage.
    const N = 1_000;
    for (let i = 0; i < N; i++) {
      const key = generateWorkspaceRecipientEncryptionKey(
        `did:dkg:agent:test-${i}`,
        `did:dkg:agent:test-${i}#x25519`,
      );
      const encoded = encodeWorkspaceEncryptionKey(key.publicKeyBytes);
      const decoded = decodeWorkspaceEncryptionKey(encoded);
      expect(decoded).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
      expect(Buffer.from(decoded).equals(Buffer.from(key.publicKeyBytes))).toBe(true);
    }
  });

  it('decodes the literal failing base64url-with-0x-prefix key from PR #792 CI', () => {
    // The exact string captured from the failing iteration (32 random
    // bytes that, by chance, encode to base64url starting with `0x`).
    const encoded = '0xbT0xAeVsXZ3f7alN53CypTY2D4ejqY6CJlfEg2Yws';
    const expected = Buffer.from(
      'd316d3d3101e56c5d9ddfeda94de770b2a536360f87a3a98e822657c4836630b',
      'hex',
    );
    const decoded = decodeWorkspaceEncryptionKey(encoded);
    expect(decoded).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
    expect(Buffer.from(decoded).equals(expected)).toBe(true);
  });

  // Regression: PR #792 round-6 bot review caught that
  //   `0x` + 41 'a' chars (length 43) is structurally indistinguishable
  // from a malformed hex key vs a legitimate base64url key — they're
  // both valid 43-char base64url AND look like a typo of canonical
  // 64-char hex. There is no length+alphabet heuristic that resolves
  // both edges without misrouting the other.
  //
  // Resolution (round 7): drop hex support from the decoder entirely.
  // `0x…hex` was dead code (no caller in this workspace produces or
  // consumes it via this API), so any 66-char canonical hex input is
  // now refused with an explicit message pointing at the base64url
  // wire format. This eliminates the ambiguity at the source.
  it('rejects canonical 0x-prefixed 32-byte hex with an explicit message', () => {
    const expected = Buffer.from(
      'd316d3d3101e56c5d9ddfeda94de770b2a536360f87a3a98e822657c4836630b',
      'hex',
    );
    const hexEncoded = `0x${expected.toString('hex')}`;
    expect(() => decodeWorkspaceEncryptionKey(hexEncoded)).toThrow(
      /refusing to decode 0x-prefixed hex form/,
    );
  });
});
