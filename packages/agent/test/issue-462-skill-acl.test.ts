/**
 * Issue-liveness repro for GH #462 — "Messaging Protocol ACL: close chat +
 * skill_request authorization gap." https://github.com/OriginTrail/dkg/issues/462
 *
 * `PROTOCOL_MESSAGE` (the transport for `skill_request`) authenticates the
 * caller's peerId via Ed25519 but performs NO authorization. So any peer that
 * can open a libp2p stream and is signed can invoke ANY registered skill on the
 * recipient — there is no policy layer between "signed by peer X" and "X may
 * invoke skill Y." Every other DKG protocol gates on an on-chain / delegation
 * ACL; `skill_request` is the outlier.
 *
 * This test asserts the CORRECT (post-fix) behaviour — an UNAUTHORIZED peer's
 * skill_request is rejected and the skill handler is NOT executed — so it is RED
 * today (no ACL: the handler runs and returns success) and turns GREEN once a
 * default-deny authorization gate is added to the skill_request dispatch. It
 * stays red until #462 is fixed. Hermetic — two in-process MessageHandlers over
 * a stub router, no libp2p.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateEd25519Keypair,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  type DKGStreamHandler,
  type EventBus,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { MessageHandler, ed25519ToX25519Private } from '../src/index.js';
import { Messenger } from '../src/p2p/messenger.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = !!process.env.RUN_ISSUE_LIVENESS;


const PEER_ATTACKER = '12D3KooWZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const PEER_VICTIM = '12D3KooWVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
const SKILL = 'did:dkg:skill:victim/sensitive-action';

function makeEventBus(): EventBus {
  return { emit: () => {}, on: () => {}, off: () => {} };
}

async function buildPair() {
  const keyA = await generateEd25519Keypair();
  const keyV = await generateEd25519Keypair();
  let attackerIncoming: DKGStreamHandler | null = null;
  let victimIncoming: DKGStreamHandler | null = null;

  const routerAttacker: ProtocolRouter = {
    register: (_p: string, h: DKGStreamHandler) => { attackerIncoming = h; },
    send: async (_to: string, _p: string, data: Uint8Array) => {
      if (!victimIncoming) throw new Error('victim handler not registered');
      return await victimIncoming(data, { toString: () => PEER_ATTACKER });
    },
  } as unknown as ProtocolRouter;
  const routerVictim: ProtocolRouter = {
    register: (_p: string, h: DKGStreamHandler) => { victimIncoming = h; },
    send: async (_to: string, _p: string, data: Uint8Array) => {
      if (!attackerIncoming) throw new Error('attacker handler not registered');
      return await attackerIncoming(data, { toString: () => PEER_VICTIM });
    },
  } as unknown as ProtocolRouter;

  const messengerA = new Messenger({ router: routerAttacker, idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: new InMemoryProtocolOutboxStore() });
  const messengerV = new Messenger({ router: routerVictim, idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: new InMemoryProtocolOutboxStore() });

  const attacker = new MessageHandler(messengerA, keyA, ed25519ToX25519Private(keyA.secretKey), PEER_ATTACKER, makeEventBus());
  const victim = new MessageHandler(messengerV, keyV, ed25519ToX25519Private(keyV.secretKey), PEER_VICTIM, makeEventBus());
  attacker.registerPeerKey(PEER_VICTIM, keyV.publicKey);
  victim.registerPeerKey(PEER_ATTACKER, keyA.publicKey);
  return { attacker, victim };
}

describe.runIf(LIVENESS_ENABLED)('GH #462 — skill_request must be authorization-gated, not just authenticated', () => {
  it(
    'a skill_request from an UNAUTHORIZED (but signed) peer is rejected and the skill handler does NOT run',
    async () => {
      const { attacker, victim } = await buildPair();

      // The victim registers a sensitive skill. It has NOT granted the attacker
      // any authorization — they merely share a libp2p connection.
      const skillHandler = vi.fn(async () => ({ success: true, outputData: new TextEncoder().encode('did-the-thing') }));
      victim.registerSkill(SKILL, skillHandler as never);

      const res = await attacker.sendSkillRequest(PEER_VICTIM, {
        skillUri: SKILL,
        inputData: new TextEncoder().encode('please run your sensitive action'),
      });

      // CORRECT (post-fix): default-deny → the attacker gets an unauthorized
      // response and the skill body never executes. Today there is no ACL, so
      // the handler runs and returns success → both assertions fail.
      expect(skillHandler).not.toHaveBeenCalled();
      expect(res.success).toBe(false);
    },
  );
});
