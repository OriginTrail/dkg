export type RsObservationOutcome =
  | { kind: 'run' }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

export type RsSenderOutcome =
  | { kind: 'ok' }
  | { kind: 'fail'; reason: string };

export function classifyObservedRsSenders(
  senders: ReadonlySet<string>,
  registered: ReadonlySet<string>,
): RsSenderOutcome {
  const unregistered = [...senders].filter((sender) => !registered.has(sender)).sort();
  if (unregistered.length === 0) return { kind: 'ok' };
  return {
    kind: 'fail',
    reason:
      `Observed RS sender(s) are not reported operational wallet(s): ${unregistered.join(', ')}. ` +
      'This is a fail-closed violation even if the observation window did not contain a full create→submit cycle.',
  };
}

export function classifyRsRotationObservation(
  create: ReadonlySet<string>,
  submit: ReadonlySet<string>,
  windowMs: number,
  requireRun: boolean,
): RsObservationOutcome {
  if (create.size > 0 && submit.size > 0) return { kind: 'run' };

  const reason =
    `RS create→submit cycle not observed within ${windowMs}ms ` +
    `(create=${create.size}, submit=${submit.size}) on this quiet devnet — lengthen DKG_RS_ROT_WINDOW. ` +
    'Rotation is unit-tested (packages/chain), not disproven here.';

  if (requireRun) {
    return {
      kind: 'fail',
      reason: `DKG_REQUIRE_RS_ROTATION=1 requires the RS rotation integration to actually observe a full cycle, but ${reason}`,
    };
  }

  return { kind: 'skip', reason };
}
