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

/**
 * Root-level TYPE contract, which the runtime package-root script cannot reach:
 * TypeScript types are erased, so `test-package-root.mjs` can prove the picker
 * is exported from the package root and prove the four resolvers are not, but
 * it is blind to whether `SystemRecordConfigControlsV1` still comes with it.
 * Dropping the type export while keeping the picker would leave that script
 * green and break every consumer that names the picker's return type.
 *
 * These imports deliberately come from the PACKAGE ROOT rather than the source
 * module the rest of this file uses: the assertions above are about the code,
 * this one is about the published surface, and only a root import can fail when
 * the barrel changes.
 */
import type {
  pickSystemRecordConfigControlsV1 as rootPickSystemRecordConfigControlsV1,
  SystemRecordConfigControlsV1 as RootSystemRecordConfigControlsV1,
} from '@origintrail-official/dkg-agent';

type RootPickerReturn = ReturnType<typeof rootPickSystemRecordConfigControlsV1>;

/**
 * KEY-SET equality, not mutual assignability. Every control field is optional,
 * and two object types whose keys differ only by optional members are mutually
 * assignable — so a pair of assignment checks would pass while the root's
 * published type gained a control the picker never forwards, or lost one it
 * does. That is a pin that cannot fail for the drift it exists to catch, which
 * is why this reuses the `Exclude<keyof A, keyof B>` shape above rather than
 * asserting the two types are compatible.
 */
type PublishedButNotReturned = Exclude<
  keyof RootSystemRecordConfigControlsV1,
  keyof RootPickerReturn
>;
type ReturnedButNotPublished = Exclude<
  keyof RootPickerReturn,
  keyof RootSystemRecordConfigControlsV1
>;

export type _RootTypePublishesExactlyWhatThePickerReturns = Expect<
  IsEmpty<PublishedButNotReturned>
>;
export type _RootPickerReturnsExactlyWhatTheRootTypePublishes = Expect<
  IsEmpty<ReturnedButNotPublished>
>;

/** The published type must still describe the picker's value, not merely share keys. */
export type _RootTypeIsAssignableFromThePickerReturn =
  Expect<RootPickerReturn extends RootSystemRecordConfigControlsV1 ? true : false>;
