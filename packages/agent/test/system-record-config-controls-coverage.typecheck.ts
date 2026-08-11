/**
 * Type-level pin: the forwarding chokepoint must cover EVERY system-record
 * control declared on the agent config, in both directions.
 *
 * Why this exists (review of PR #2255). `pickSystemRecordConfigControlsV1`
 * forwards exactly the fields named in `SystemRecordConfigControlsV1`. That
 * closes the silent-drop hazard for the fields IN that interface — but it does
 * nothing about a FIFTH control added to `DKGAgentConfig` and forgotten here:
 * the picker would simply not forward it, and it would be documented,
 * operator-settable and inert. That is the same defect class the chokepoint was
 * built to prevent, one level up, and neither the pinned return type nor the
 * CLI wiring test catches it (the type sees no error, and the wiring test
 * iterates the four names it knows).
 *
 * The pin runs in `pnpm run test:types`, which `build` invokes, so it fails the
 * build rather than a lane someone might not run.
 *
 * KNOWN LIMIT, stated rather than implied: this keys on the `systemRecord`
 * NAME PREFIX, which is a convention, not a contract. A fifth control named
 * outside that convention escapes the pin. The prefix is what every control in
 * the ratified `:1436` inventory uses, so the pin holds for the shape the plan
 * actually describes — but it is a convention pinned by a naming habit, and a
 * reviewer should know that rather than read this as total.
 */
import type { DKGAgentConfig } from '../src/dkg-agent-types.js';
import type { SystemRecordConfigControlsV1 } from '../src/system-records/config-controls-v1.js';

/** Fails to compile unless `T` is exactly `true`. */
type Expect<T extends true> = T;

/**
 * `[X] extends [never]` rather than `X extends never`: the naked form
 * distributes over unions and silently evaluates to `never` for an empty one,
 * which would make this pin pass no matter what. The tuple wrapper blocks
 * distribution, so an empty difference is genuinely `true` and a non-empty one
 * is genuinely `false`.
 */
type IsEmpty<T> = [T] extends [never] ? true : false;

type ControlKeysOnAgentConfig = Extract<keyof DKGAgentConfig, `systemRecord${string}`>;

/** A control the agent config declares but the chokepoint would not forward. */
type NotForwarded = Exclude<ControlKeysOnAgentConfig, keyof SystemRecordConfigControlsV1>;

/** A control the chokepoint forwards that the agent config does not declare. */
type NotDeclared = Exclude<keyof SystemRecordConfigControlsV1, ControlKeysOnAgentConfig>;

export type _EveryAgentControlIsForwarded = Expect<IsEmpty<NotForwarded>>;
export type _EveryForwardedControlIsDeclared = Expect<IsEmpty<NotDeclared>>;
