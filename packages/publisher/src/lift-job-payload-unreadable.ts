/**
 * The one error a read of the publisher control graph throws for a persisted LiftJob it cannot use (OT-RFC-73 P11): a payload that does not decode, one whose
 * state this build does not know, or a record whose stored lifecycle key is not the one its payload names. Callers that must tell such a record apart from a
 * store failure (bulk `clear(status)` and retention keep the jobs of a key they cannot read, and pass any other error on) test for this type, never for the
 * wording of the message: the message is diagnostics and keeps its text (`Malformed persisted LiftJob payload: ...`) for the people who read it.
 */
export class LiftJobPayloadUnreadableError extends Error {
  readonly code = 'LIFT_JOB_PAYLOAD_UNREADABLE';
}
