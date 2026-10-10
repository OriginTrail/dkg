// SPDX-License-Identifier: Apache-2.0

import { createOperationContext, type Logger } from '@origintrail-official/dkg-core';

import { rememberBounded } from '../bounded-map.js';
import type {
  Rfc64CatalogHeadDeliveryOutcomeV1,
  Rfc64CatalogHeadHandoffV1,
} from '../rfc64/public-catalog-head-delivery-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../rfc64/public-catalog-transport-v1.js';

/**
 * GH#3081 — what the agent writes about the delivery of catalog heads. Observation only.
 *
 * Delivery runs after the catalog mutation that produced a head has returned, so nothing here
 * can reach that mutation or its caller. That is also why a head that does not reach a peer has
 * to leave a line of its own, whatever the reason:
 *
 * - every fan-out writes one debug line with its counts;
 * - a hand-off that nobody took, a head that could not be fanned out, peers this node could not
 *   check, peers whose authorization could not be confirmed after their send, and a waiting head
 *   that could not be kept each write a visible line.
 *
 * A peer this node's policy refused is not among them: a refusal is an answer, and a head with no
 * eligible peer writes nothing above debug level. A peer the node could not check is different.
 * The policy did not answer, so a node in that state delivers to nobody, and it says so at warn.
 *
 * Every visible line is written at most once per {@link CATALOG_HEAD_DELIVERY_LOG_WINDOW_MS} for
 * its subject (a catalog, or a reason), and the next one says how many it stands for. Nothing is
 * held back from the counts: {@link CatalogHeadDeliveryReportV1.status} has every hand-off and
 * every reported head, for `/api/status`.
 */
export const CATALOG_HEAD_DELIVERY_LOG_WINDOW_MS = 60_000;
const MAX_TRACKED_SUBJECTS = 1_024;

type DeliveryLog = Pick<Logger, 'debug' | 'info' | 'warn'>;

/**
 * Head delivery in counts since this process started. Counts only: no peer, author or graph id.
 * A peer counts once for every head it was named for.
 */
export interface CatalogHeadDeliveryStatusV1 {
  /** Hand-offs the delivery owner took. */
  readonly handoffsQueued: number;
  /** Hand-offs with nobody to send to. */
  readonly handoffsNobody: number;
  /** Hand-offs nobody took. Their heads stay durable and reach peers later, or through replay. */
  readonly handoffsNotQueued: number;
  /** Heads whose delivery ended and was reported: fanned out, or not deliverable. */
  readonly reportedHeads: number;
  readonly deliveredPeers: number;
  readonly failedPeers: number;
  /** Peers this node's policy refused. Nothing was sent to them. */
  readonly refusedPeers: number;
  /** Peers this node's policy check did not answer for. Nothing was sent to them either. */
  readonly uncheckedPeers: number;
  /** Peers a head was sent to whose authorization could not be confirmed afterwards. */
  readonly unconfirmedPeers: number;
  /** Waiting heads a newer head of their catalog replaced before they were sent. */
  readonly supersededHeads: number;
  /** Reported heads that were not fanned out at all. */
  readonly undeliverableHeads: number;
  /** Reported heads before which a waiting head could not be kept. */
  readonly checkpointCapacityExceeded: number;
}

export class CatalogHeadDeliveryReportV1 {
  readonly #now: () => number;
  /** When each subject last wrote a line, and how many lines it held back since. */
  readonly #subjects = new Map<string, { writtenAt: number; heldBack: number }>();
  readonly #counts: { -readonly [Counter in keyof CatalogHeadDeliveryStatusV1]: number } = {
    handoffsQueued: 0,
    handoffsNobody: 0,
    handoffsNotQueued: 0,
    reportedHeads: 0,
    deliveredPeers: 0,
    failedPeers: 0,
    refusedPeers: 0,
    uncheckedPeers: 0,
    unconfirmedPeers: 0,
    supersededHeads: 0,
    undeliverableHeads: 0,
    checkpointCapacityExceeded: 0,
  };

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** What has been counted so far. */
  status(): Readonly<CatalogHeadDeliveryStatusV1> {
    return Object.freeze({ ...this.#counts });
  }

  /** The receipt of one hand-off. Only a hand-off that nobody took writes a line. */
  handoff(
    log: DeliveryLog,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1 | undefined,
    receipt: Rfc64CatalogHeadHandoffV1,
  ): void {
    observe(() => {
      if (receipt.status === 'queued') this.#counts.handoffsQueued += 1;
      else if (receipt.status === 'nobody') this.#counts.handoffsNobody += 1;
      else this.#counts.handoffsNotQueued += 1;
      if (receipt.status !== 'not-queued') return;
      const reason = receipt.reason ?? 'unavailable';
      // No free scope, or a peer list the hand-off rejects, is this node's own trouble. A node
      // that is stopping or has no catalog service, and a caller that gave up, are as expected.
      const level = reason === 'full' || reason === 'invalid' ? 'warn' : 'info';
      this.#write(log, level, `handoff ${reason}`, 'RFC-64 catalog head was not queued for delivery'
        + `${describeHead(announcement)} reason=${reason}`);
    });
  }

  /** One finished fan-out of a handed-off head. */
  delivered(log: DeliveryLog, outcome: Rfc64CatalogHeadDeliveryOutcomeV1): void {
    observe(() => {
      const head = describeHead(outcome.announcement);
      const scope = `${outcome.announcement.contextGraphId} ${outcome.announcement.authorAddress}`;
      const unchecked = outcome.uncheckedPeers.length;
      const unconfirmed = outcome.unconfirmedPeers.length;
      this.#counts.reportedHeads += 1;
      this.#counts.deliveredPeers += outcome.announcedPeers.length;
      this.#counts.failedPeers += outcome.failedPeers.length;
      this.#counts.refusedPeers += outcome.refusedPeers.length;
      this.#counts.uncheckedPeers += unchecked;
      this.#counts.unconfirmedPeers += unconfirmed;
      this.#counts.supersededHeads += outcome.supersededHeads;
      if (outcome.notDeliverable !== null) this.#counts.undeliverableHeads += 1;
      if (outcome.checkpointCapacityExceeded) this.#counts.checkpointCapacityExceeded += 1;
      log.debug(
        createOperationContext('system'),
        `rfc64_catalog_head_delivery${head}`
          + ` delivered=${outcome.announcedPeers.length}`
          + ` failed=${outcome.failedPeers.length}`
          + ` refused=${outcome.refusedPeers.length}`
          + ` unchecked=${unchecked}`
          + ` unconfirmed=${unconfirmed}`
          + ` superseded=${outcome.supersededHeads}`
          + ` checkpointCapacityExceeded=${outcome.checkpointCapacityExceeded}`
          + ` durationMs=${Math.round(outcome.durationMs)}`
          + ` notDeliverable=${JSON.stringify(outcome.notDeliverable?.slice(0, 160) ?? null)}`,
      );
      if (outcome.notDeliverable !== null) {
        this.#write(log, 'info', `undeliverable ${scope}`, 'RFC-64 catalog head was not fanned out'
          + `${head}: ${outcome.notDeliverable.slice(0, 160)}`);
      }
      if (unchecked > 0) {
        const named = outcome.announcedPeers.length + outcome.failedPeers.length
          + outcome.refusedPeers.length + unchecked + unconfirmed;
        this.#write(log, 'warn', `unchecked ${scope}`, 'RFC-64 catalog head delivery could not check'
          + ` ${unchecked}/${named} peer(s)${head}:`
          + ' this node\'s policy check did not answer for them, so they were sent nothing');
      }
      if (unconfirmed > 0) {
        this.#write(log, 'info', `unconfirmed ${scope}`, `RFC-64 catalog head was sent to ${unconfirmed}`
          + ` peer(s) whose authorization could not be confirmed once the send had finished${head}`
          + ` peers=${outcome.unconfirmedPeers.map((peerId) => peerId.slice(-8)).join(',')}`);
      }
      if (outcome.checkpointCapacityExceeded) {
        this.#write(log, 'warn', `capacity ${scope}`, 'RFC-64 catalog head delivery could not keep a'
          + ` waiting head${head}: peers named for it may have been left out, and a peer more than a`
          + ' lineage window behind the newest head cannot apply it');
      }
    });
  }

  /** Write `line` unless its subject wrote one within the window; say how many were held back. */
  #write(log: DeliveryLog, level: 'info' | 'warn', subject: string, line: string): void {
    const now = this.#now();
    const last = this.#subjects.get(subject);
    if (last !== undefined && now - last.writtenAt < CATALOG_HEAD_DELIVERY_LOG_WINDOW_MS) {
      last.heldBack += 1;
      return;
    }
    rememberBounded(this.#subjects, subject, { writtenAt: now, heldBack: 0 }, MAX_TRACKED_SUBJECTS);
    const heldBack = last?.heldBack ?? 0;
    log[level](
      createOperationContext('system'),
      heldBack === 0 ? line : `${line} (and ${heldBack} more like it since the last line)`,
    );
  }
}

function observe(report: () => void): void {
  try {
    report();
  } catch { /* observation only */ }
}

function describeHead(announcement: Rfc64PublicCatalogHeadAnnouncementV1 | undefined): string {
  return ` head=${announcement?.catalogHeadObjectDigest}`
    + ` cg=${announcement?.contextGraphId}`
    + ` version=${announcement?.catalogVersion}`;
}

const REPORTS_V1 = new WeakMap<object, CatalogHeadDeliveryReportV1>();

/** The delivery report of one agent, created on first use. */
export function catalogHeadDeliveryReportV1(owner: object): CatalogHeadDeliveryReportV1 {
  let report = REPORTS_V1.get(owner);
  if (report === undefined) {
    report = new CatalogHeadDeliveryReportV1();
    REPORTS_V1.set(owner, report);
  }
  return report;
}

/** Replace `owner`'s delivery report, for example with an injected clock. */
export function installCatalogHeadDeliveryReportV1(
  owner: object,
  report: CatalogHeadDeliveryReportV1,
): void {
  REPORTS_V1.set(owner, report);
}
