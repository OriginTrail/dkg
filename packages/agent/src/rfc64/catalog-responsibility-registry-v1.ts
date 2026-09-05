// SPDX-License-Identifier: Apache-2.0

import type { Rfc64CatalogRolloutModeV1 } from './catalog-rollout-authority-v1.js';

/** Normal DKG lifecycle fact that makes this node responsible for one CG. */
export type Rfc64CatalogResponsibilityReasonV1 =
  | 'core-public'
  | 'edge-subscription'
  | 'private-membership';

/** Provenance of the effective RFC-64 selection reported to operators. */
export type Rfc64CatalogSelectionSourceV1 =
  | 'default'
  | 'operator-override'
  | 'kill-switch';

export interface Rfc64CatalogResponsibilityRegistryControlsV1 {
  /** Product default for responsible CGs. DKG 10.0.16 supplies `catalog`. */
  readonly defaultMode?: Rfc64CatalogRolloutModeV1;
  /** Explicit, restart-stable per-CG emergency rollout overrides. */
  readonly contextGraphModes?: Readonly<Record<string, Rfc64CatalogRolloutModeV1>>;
  /** Emergency stop. It suspends Track-2 without silently selecting legacy. */
  readonly killSwitchActive?: boolean;
}

export interface Rfc64CatalogResponsibilitySelectionV1 {
  readonly contextGraphId: string;
  readonly responsible: boolean;
  readonly responsibilityReason: Rfc64CatalogResponsibilityReasonV1 | null;
  /** False only outside the responsibility set or while the kill switch is active. */
  readonly active: boolean;
  readonly mode: Rfc64CatalogRolloutModeV1;
  readonly selectionSource: Rfc64CatalogSelectionSourceV1;
}

export interface Rfc64CatalogResponsibilityTransitionV1 {
  readonly changed: boolean;
  readonly previous: Rfc64CatalogResponsibilitySelectionV1;
  readonly next: Rfc64CatalogResponsibilitySelectionV1;
}

export interface ResolveRfc64CatalogResponsibilityReasonInputV1 {
  readonly nodeRole: 'core' | 'edge';
  readonly subscribed: boolean;
  /** Durable Core custody fact. Its producer is restricted to public CGs. */
  readonly coreHosted: boolean;
  /** Canonically verified access policy; `null` remains fail-closed. */
  readonly accessPolicy: 'public' | 'private' | null;
  /** Current local-agent membership verified without subscription fallback. */
  readonly privateMembershipVerified: boolean;
}

const RFC64_CATALOG_RESPONSIBILITY_REASONS_V1 =
  new Set<Rfc64CatalogResponsibilityReasonV1>([
    'core-public',
    'edge-subscription',
    'private-membership',
  ]);

const RFC64_CATALOG_ROLLOUT_MODES_V1 = new Set<Rfc64CatalogRolloutModeV1>([
  'legacy',
  'shadow',
  'catalog',
]);

/**
 * Convert already-verified normal lifecycle facts into one responsibility.
 * A subscription is never treated as private membership, and unknown policy
 * never activates an Edge receiver.
 */
export function resolveRfc64CatalogResponsibilityReasonV1(
  input: ResolveRfc64CatalogResponsibilityReasonInputV1,
): Rfc64CatalogResponsibilityReasonV1 | null {
  if (input.coreHosted) {
    return input.accessPolicy === 'private' ? null : 'core-public';
  }
  if (input.accessPolicy === null) return null;
  if (input.accessPolicy === 'private') {
    return input.privateMembershipVerified ? 'private-membership' : null;
  }
  if (!input.subscribed) return null;
  return input.nodeRole === 'core' ? 'core-public' : 'edge-subscription';
}

/**
 * Process-local projection of durable DKG lifecycle state into RFC-64 desired
 * selection. Authority acceptance deliberately remains outside this class:
 * responsibility can select `catalog` while policy/roster resolution is still
 * fail-closed and incomplete.
 */
export class Rfc64CatalogResponsibilityRegistryV1 {
  readonly #defaultMode: Rfc64CatalogRolloutModeV1;
  readonly #contextGraphModes: Readonly<Record<string, Rfc64CatalogRolloutModeV1>>;
  readonly #killSwitchActive: boolean;
  readonly #responsibilities = new Map<string, Rfc64CatalogResponsibilityReasonV1>();

  constructor(controls: Rfc64CatalogResponsibilityRegistryControlsV1 = {}) {
    this.#defaultMode = controls.defaultMode ?? 'catalog';
    assertRfc64CatalogRolloutModeV1(this.#defaultMode, 'defaultMode');
    this.#contextGraphModes = snapshotContextGraphModesV1(controls.contextGraphModes);
    if (
      controls.killSwitchActive !== undefined
      && typeof controls.killSwitchActive !== 'boolean'
    ) {
      throw new TypeError('RFC-64 responsibility killSwitchActive must be a boolean');
    }
    this.#killSwitchActive = controls.killSwitchActive ?? false;
  }

  /** Replace one CG's lifecycle-derived responsibility atomically. */
  setResponsibility(
    contextGraphId: string,
    reason: Rfc64CatalogResponsibilityReasonV1 | null,
  ): Rfc64CatalogResponsibilityTransitionV1 {
    assertContextGraphIdV1(contextGraphId);
    if (
      reason !== null
      && !RFC64_CATALOG_RESPONSIBILITY_REASONS_V1.has(reason)
    ) {
      throw new TypeError(`Unknown RFC-64 responsibility reason: ${String(reason)}`);
    }
    const previous = this.read(contextGraphId);
    if (reason === null) this.#responsibilities.delete(contextGraphId);
    else this.#responsibilities.set(contextGraphId, reason);
    const next = this.read(contextGraphId);
    return Object.freeze({
      changed:
        previous.responsibilityReason !== next.responsibilityReason
        || previous.active !== next.active
        || previous.mode !== next.mode
        || previous.selectionSource !== next.selectionSource,
      previous,
      next,
    });
  }

  read(contextGraphId: string): Rfc64CatalogResponsibilitySelectionV1 {
    assertContextGraphIdV1(contextGraphId);
    const responsibilityReason = this.#responsibilities.get(contextGraphId) ?? null;
    const responsible = responsibilityReason !== null;
    const configuredMode = this.#contextGraphModes[contextGraphId];
    const mode = configuredMode ?? this.#defaultMode;
    return Object.freeze({
      contextGraphId,
      responsible,
      responsibilityReason,
      active: responsible && !this.#killSwitchActive,
      mode,
      selectionSource: this.#killSwitchActive && responsible
        ? 'kill-switch'
        : configuredMode === undefined
          ? this.#defaultMode === 'catalog'
            ? 'default'
            : 'operator-override'
          : 'operator-override',
    });
  }

  /** Stable, immutable status projection for harness and operator evidence. */
  snapshot(): readonly Rfc64CatalogResponsibilitySelectionV1[] {
    return Object.freeze(
      [...this.#responsibilities.keys()]
        .sort()
        .map((contextGraphId) => this.read(contextGraphId)),
    );
  }
}

function snapshotContextGraphModesV1(
  input: Readonly<Record<string, Rfc64CatalogRolloutModeV1>> | undefined,
): Readonly<Record<string, Rfc64CatalogRolloutModeV1>> {
  if (input === undefined) return Object.freeze(Object.create(null));
  if (
    input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || (
      Object.getPrototypeOf(input) !== Object.prototype
      && Object.getPrototypeOf(input) !== null
    )
  ) {
    throw new TypeError('RFC-64 responsibility contextGraphModes must be a plain object');
  }
  const snapshot: Record<string, Rfc64CatalogRolloutModeV1> = Object.create(null);
  for (const [contextGraphId, mode] of Object.entries(input)) {
    assertContextGraphIdV1(contextGraphId);
    assertRfc64CatalogRolloutModeV1(mode, `contextGraphModes.${contextGraphId}`);
    snapshot[contextGraphId] = mode;
  }
  return Object.freeze(snapshot);
}

function assertRfc64CatalogRolloutModeV1(
  input: unknown,
  label: string,
): asserts input is Rfc64CatalogRolloutModeV1 {
  if (!RFC64_CATALOG_ROLLOUT_MODES_V1.has(input as Rfc64CatalogRolloutModeV1)) {
    throw new TypeError(`RFC-64 responsibility ${label} must be legacy, shadow, or catalog`);
  }
}

function assertContextGraphIdV1(contextGraphId: string): void {
  if (typeof contextGraphId !== 'string' || contextGraphId.trim().length === 0) {
    throw new TypeError('RFC-64 responsibility contextGraphId must be a non-empty string');
  }
}
