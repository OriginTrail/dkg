/**
 * Root DECLARATION-surface contract for the system-record config controls.
 *
 * Split out of `system-record-config-controls-coverage.typecheck.ts` in review:
 * that file is a SOURCE-level check and reads `../src/...` directly, while this
 * one deliberately reads the package root, i.e. the GENERATED `dist/index.d.ts`.
 * Holding both in one file hid a real dependency — a source typecheck that
 * silently required a prior emit.
 *
 * ORDERING, stated rather than implied: this file resolves only after `tsc` has
 * emitted declarations. The package `build` script is
 * `tsc && test:types && test:package-root`, so the emit always precedes it
 * there; running `test:types` alone against a never-built checkout will not
 * resolve this import. That is the cost of pinning a PUBLISHED surface, and it
 * is exactly why the assertion cannot live on the source module: a source
 * import would keep passing while the BARREL dropped the type, which is the
 * drift this exists to catch.
 *
 * What the runtime package-root script cannot do, and why this file exists:
 * TypeScript types are erased, so `test-package-root.mjs` can prove the picker
 * is exported from the root and prove the resolvers are not, while being blind
 * to whether `SystemRecordConfigControlsV1` still ships with it. Dropping the
 * type export while keeping the picker leaves that script green and breaks
 * every consumer that names the picker's return type.
 */
import type {
  pickSystemRecordConfigControlsV1 as rootPickSystemRecordConfigControlsV1,
  SystemRecordConfigControlsV1 as RootSystemRecordConfigControlsV1,
} from '@origintrail-official/dkg-agent';

/** Fails to compile unless `T` is exactly `true`. */
type Expect<T extends true> = T;

/**
 * `[X] extends [never]` rather than `X extends never`: the naked form
 * distributes over unions and evaluates to `never` for an empty one, which
 * would make these pins pass no matter what. The tuple wrapper blocks
 * distribution.
 */
type IsEmpty<T> = [T] extends [never] ? true : false;

type RootPickerReturn = ReturnType<typeof rootPickSystemRecordConfigControlsV1>;

/**
 * KEY-SET equality, not mutual assignability. Every control field is optional,
 * and two object types whose keys differ only by optional members are mutually
 * assignable — so a pair of assignment checks would pass while the root's
 * published type gained a control the picker never forwards, or lost one it
 * does. That is a pin that cannot fail for the drift it exists to catch.
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

/**
 * NEGATIVE declaration checks: the per-control resolvers must not be reachable
 * from the root's TYPES either. A type-only re-export
 * (`export type { systemRecordProducerTrackingEnabledV1 } from './…'`) publishes
 * the resolver's name and shape while adding no runtime export — invisible to
 * `test-package-root.mjs`, which sees only values, and invisible to every
 * positive assertion above, which only asks what IS published.
 *
 * Each `@ts-expect-error` below asserts the import FAILS. If a resolver ever
 * becomes reachable from the root declarations, the error disappears, the
 * directive becomes unused, and TypeScript reports THAT — so these fail in the
 * right direction rather than silently passing.
 */
// @ts-expect-error — must not be reachable from the package root declarations.
import type { systemRecordProducerTrackingEnabledV1 as _p } from '@origintrail-official/dkg-agent';
// @ts-expect-error — must not be reachable from the package root declarations.
import type { systemRecordProviderAdvertisementEnabledV1 as _a } from '@origintrail-official/dkg-agent';
// @ts-expect-error — must not be reachable from the package root declarations.
import type { systemRecordRequesterLaneEnabledV1 as _r } from '@origintrail-official/dkg-agent';
// @ts-expect-error — must not be reachable from the package root declarations.
import type { systemRecordLegacyCapablePeerSelectionEnabledV1 as _l } from '@origintrail-official/dkg-agent';

export type _ResolverDeclarationsStayPrivate = [
  typeof _p,
  typeof _a,
  typeof _r,
  typeof _l,
] extends never[]
  ? true
  : true;
