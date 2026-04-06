import { createHash } from 'node:crypto';
import type {
  AKAEvent,
  SessionState,
  RoundProposalPayload,
  RoundAckPayload,
  InputPayload,
} from './types.js';
import { verifyAKASignature, type SigningContext } from './canonical.js';

const DEFAULT_CLOCK_SKEW_TOLERANCE = 5_000;

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export class SessionValidator {
  private readonly clockSkewTolerance: number;
  private seenNonces = new Map<string, Set<string>>();
  private seenTuples = new Set<string>();

  constructor(clockSkewTolerance = DEFAULT_CLOCK_SKEW_TOLERANCE) {
    this.clockSkewTolerance = clockSkewTolerance;
  }

  async validate(event: AKAEvent, session: SessionState, network: string): Promise<ValidationResult> {
    const checks: Array<() => ValidationResult | Promise<ValidationResult>> = [
      () => this.checkMode(event),
      () => this.checkSessionExists(event, session),
      () => this.checkMembership(event, session),
      () => this.checkSchemaConformance(event),
      () => this.checkReplayProtection(event),
      () => this.checkSignature(event, session, network),
    ];

    if (isRoundEvent(event.type)) {
      checks.push(
        () => this.checkStateLinkage(event, session),
        () => this.checkTiming(event, session),
        () => this.checkEquivocation(event, session),
      );
    }

    if (event.type === 'RoundProposal' || event.type === 'RoundStart' || event.type === 'RoundFinalized') {
      checks.push(() => this.checkProposerAuthority(event, session));
    }

    if (event.type === 'SessionActivated') {
      checks.push(() => this.checkCreatorAuthority(event, session));
    }

    for (const check of checks) {
      const result = await check();
      if (!result.valid) return result;
    }

    this.recordEvent(event);
    return { valid: true };
  }

  reset(sessionId: string): void {
    for (const [key] of this.seenNonces) {
      if (key.startsWith(sessionId)) this.seenNonces.delete(key);
    }
    for (const tuple of this.seenTuples) {
      if (tuple.startsWith(sessionId)) this.seenTuples.delete(tuple);
    }
  }

  private checkMode(event: AKAEvent): ValidationResult {
    if (event.mode !== 'AKA') {
      return { valid: false, reason: `invalid mode: expected "AKA", got "${event.mode}"` };
    }
    return { valid: true };
  }

  private checkSessionExists(event: AKAEvent, session: SessionState): ValidationResult {
    if (session.config.sessionId !== event.sessionId) {
      return { valid: false, reason: `session ${event.sessionId} not found` };
    }
    if (event.type !== 'SessionAccepted' && event.type !== 'SessionActivated' && event.type !== 'SessionAborted') {
      if (session.config.status !== 'active') {
        return { valid: false, reason: `session is ${session.config.status}, not active` };
      }
    }
    return { valid: true };
  }

  private checkMembership(event: AKAEvent, session: SessionState): ValidationResult {
    const member = session.config.membership.find((m) => m.peerId === event.signerPeerId);
    if (!member) {
      return { valid: false, reason: `signer ${event.signerPeerId} is not a session member` };
    }
    return { valid: true };
  }

  private checkSchemaConformance(event: AKAEvent): ValidationResult {
    if (!event.type || !event.sessionId || !event.signerPeerId || !event.nonce) {
      return { valid: false, reason: 'missing required fields' };
    }
    if (!event.signature || event.signature.length === 0) {
      return { valid: false, reason: 'missing signature' };
    }
    return { valid: true };
  }

  private checkStateLinkage(event: AKAEvent, session: SessionState): ValidationResult {
    if (event.prevStateHash !== session.latestStateHash) {
      return {
        valid: false,
        reason: `state linkage mismatch: event references ${event.prevStateHash}, local is ${session.latestStateHash}`,
      };
    }
    return { valid: true };
  }

  private checkReplayProtection(event: AKAEvent): ValidationResult {
    const nonceKey = `${event.sessionId}|${event.signerPeerId}`;
    const nonces = this.seenNonces.get(nonceKey);
    if (nonces?.has(event.nonce)) {
      return { valid: false, reason: `duplicate nonce: ${event.nonce}` };
    }

    // For RoundAck, include a full payload hash so conflicting ACKs from the
    // same signer reach the SessionManager for equivocation detection.
    const payloadSuffix = event.type === 'RoundAck'
      ? `|${createHash('sha256').update(event.payload).digest('hex')}`
      : '';
    const tupleKey = `${event.sessionId}|${event.round}|${event.signerPeerId}|${event.type}${payloadSuffix}`;
    if (this.seenTuples.has(tupleKey)) {
      return { valid: false, reason: `duplicate event tuple: ${tupleKey}` };
    }

    return { valid: true };
  }

  private checkTiming(event: AKAEvent, session: SessionState): ValidationResult {
    const roundState = session.roundStates.get(event.round);
    if (!roundState?.startTime) return { valid: true };

    const lower = roundState.startTime - this.clockSkewTolerance;
    const upper = roundState.startTime + session.config.roundTimeout + this.clockSkewTolerance;

    if (event.timestamp < lower || event.timestamp > upper) {
      return {
        valid: false,
        reason: `timestamp ${event.timestamp} outside valid window [${lower}, ${upper}]`,
      };
    }
    return { valid: true };
  }

  private checkEquivocation(event: AKAEvent, session: SessionState): ValidationResult {
    if (session.equivocators.has(event.signerPeerId)) {
      return { valid: false, reason: `signer ${event.signerPeerId} is an equivocator` };
    }
    return { valid: true };
  }

  private checkCreatorAuthority(event: AKAEvent, session: SessionState): ValidationResult {
    if (event.signerPeerId !== session.config.createdBy) {
      return {
        valid: false,
        reason: `${event.signerPeerId} is not the session creator (expected ${session.config.createdBy})`,
      };
    }
    return { valid: true };
  }

  private checkProposerAuthority(event: AKAEvent, session: SessionState): ValidationResult {
    const roundState = session.roundStates.get(event.round);
    if (!roundState) return { valid: true };

    if (event.signerPeerId !== roundState.proposerPeerId) {
      return {
        valid: false,
        reason: `${event.signerPeerId} is not the proposer for round ${event.round} (expected ${roundState.proposerPeerId})`,
      };
    }
    return { valid: true };
  }

  private async checkSignature(
    event: AKAEvent,
    session: SessionState,
    network: string,
  ): Promise<ValidationResult> {
    const member = session.config.membership.find((m) => m.peerId === event.signerPeerId);
    if (!member) return { valid: false, reason: 'signer not found in membership' };

    const context: SigningContext = {
      domain: 'AKA-v1',
      network,
      contextGraphId: session.config.contextGraphId,
      sessionId: event.sessionId,
      round: event.round,
      type: event.type,
    };

    const valid = await verifyAKASignature(
      context,
      Array.from(event.payload),
      event.signature,
      member.pubKey,
    );

    if (!valid) {
      return { valid: false, reason: 'invalid Ed25519 signature' };
    }
    return { valid: true };
  }

  private recordEvent(event: AKAEvent): void {
    const payloadSuffix = event.type === 'RoundAck'
      ? `|${createHash('sha256').update(event.payload).digest('hex')}`
      : '';
    const tupleKey = `${event.sessionId}|${event.round}|${event.signerPeerId}|${event.type}${payloadSuffix}`;
    this.seenTuples.add(tupleKey);

    const nonceKey = `${event.sessionId}|${event.signerPeerId}`;
    let nonces = this.seenNonces.get(nonceKey);
    if (!nonces) {
      nonces = new Set();
      this.seenNonces.set(nonceKey, nonces);
    }
    nonces.add(event.nonce);
  }
}

function isRoundEvent(type: string): boolean {
  return [
    'RoundStart',
    'InputSubmitted',
    'RoundProposal',
    'RoundAck',
    'RoundFinalized',
    'RoundTimeout',
  ].includes(type);
}

export function detectEquivocation(
  existing: RoundAckPayload,
  incoming: RoundAckPayload,
): boolean {
  return existing.nextStateHash !== incoming.nextStateHash;
}
