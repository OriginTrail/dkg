/**
 * @devnet spec — the real KA publish lifecycle expressed as behaviour.
 *
 * Binds bdd/features/ka-lifecycle.feature to the same daemon routes that
 * devnet/v10-core-flows' fullPublish() exercises, sharing the produced
 * assertion + kaId through per-scenario closure state (the test "World").
 *
 * Tag-gated: if no devnet is provisioned on disk, the @devnet scenarios are
 * excluded (skipped cleanly) instead of failing — mirroring how the existing
 * devnet suites guard, but as a skip rather than a hard error.
 */
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_GRAPH,
  type DevnetNode,
  detectDevnet,
  ensureIdentity,
  postJson,
  probeStatus,
} from '../support/world.js';

const here = dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(resolve(here, '../features/ka-lifecycle.feature'));

const probe = detectDevnet();
const excludeTags = probe.available ? [] : ['devnet'];
if (!probe.available) {
  console.warn(`[bdd] @devnet scenarios skipped — ${probe.reason}`);
}

describeFeature(
  feature,
  ({ Background, Scenario, BeforeAllScenarios }) => {
    // Accessor instead of an unsafe cast: only ever invoked when the @devnet
    // scenario actually runs (which only happens when a devnet is present).
    const node = (): DevnetNode => {
      if (!probe.node) {
        throw new Error('devnet node unavailable — scenario should have been skipped');
      }
      return probe.node;
    };

    // Register setup only when a devnet is present. When it is absent the
    // scenario is excluded, and this hook must not run at all.
    if (probe.available) {
      BeforeAllScenarios(async () => {
        if (!(await probeStatus(node()))) {
          throw new Error(
            `devnet node${node().num} (${node().api}) is provisioned but not answering /api/status`,
          );
        }
        // The chain-publish step needs an on-chain identity; bootstrap usually
        // provides it, this is an idempotent safety net.
        await ensureIdentity(node());
      });
    }

    Background(({ Given, And }) => {
      Given('a reachable devnet node with an authenticated agent', () => {
        expect(probe.node?.api, 'no devnet node resolved').toBeTruthy();
      });
      And('the "devnet-test" context graph', () => {
        expect(CONTEXT_GRAPH).toBe('devnet-test');
      });
    });

    Scenario(
      'A signed assertion becomes a confirmed on-chain Knowledge Asset',
      ({ Given, When, Then, And }) => {
        // Per-scenario World — declared here so each scenario gets fresh state
        // (no bleed across scenarios as more are added).
        const contextGraphId = CONTEXT_GRAPH;
        let assertionName = '';
        let finalizeRes: { merkleRoot?: string; eip712Digest?: string } = {};
        let promoteRes: { promotedCount?: number } = {};
        let publishRes: { kaId?: string; status?: string } = {};

        Given('a fresh draft assertion in the context graph', async () => {
          assertionName = `bdd-ka-${Date.now()}`;
          const r = await postJson(node(), '/api/assertion/create', {
            contextGraphId,
            name: assertionName,
          });
          expect(r.status, JSON.stringify(r.body)).toBe(200);
        });

        When('I write 2 entity quads to the assertion', async () => {
          const subject = `urn:test:bdd:${assertionName}`;
          const quads = [
            { subject, predicate: 'http://schema.org/name', object: `"${assertionName}"`, graph: '' },
            { subject, predicate: 'http://schema.org/value', object: '"bdd pilot"', graph: '' },
          ];
          const r = await postJson(node(), `/api/assertion/${assertionName}/write`, {
            contextGraphId,
            quads,
          });
          expect(r.status, JSON.stringify(r.body)).toBe(200);
          expect(Number(r.body?.written ?? 0)).toBeGreaterThanOrEqual(2);
        });

        And('I finalize the assertion', async () => {
          const r = await postJson(node(), `/api/assertion/${assertionName}/finalize`, {
            contextGraphId,
          });
          expect(r.status, JSON.stringify(r.body)).toBe(200);
          finalizeRes = r.body;
        });

        Then('the assertion has a merkle root and an EIP-712 digest', () => {
          expect(finalizeRes.merkleRoot, JSON.stringify(finalizeRes)).toMatch(/^0x[0-9a-fA-F]+$/);
          expect(finalizeRes.eip712Digest, JSON.stringify(finalizeRes)).toMatch(/^0x[0-9a-fA-F]+$/);
        });

        When('I promote the assertion to shared working memory', async () => {
          const r = await postJson(node(), `/api/assertion/${assertionName}/promote`, {
            contextGraphId,
          });
          expect(r.status, JSON.stringify(r.body)).toBe(200);
          promoteRes = r.body;
        });

        Then('at least 1 share is created', () => {
          expect(Number(promoteRes.promotedCount ?? 0)).toBeGreaterThanOrEqual(1);
        });

        When('I publish the assertion to the chain', async () => {
          const r = await postJson(node(), '/api/shared-memory/publish', {
            contextGraphId,
            assertionName,
          });
          expect(r.status, JSON.stringify(r.body)).toBe(200);
          publishRes = r.body;
        });

        Then('a knowledge asset id is returned', () => {
          expect(BigInt(publishRes.kaId ?? '0'), JSON.stringify(publishRes)).toBeGreaterThan(0n);
        });

        And('the knowledge asset status is one of "confirmed,tentative,finalized"', () => {
          expect(['confirmed', 'tentative', 'finalized']).toContain(
            String(publishRes.status).toLowerCase(),
          );
        });
      },
    );
  },
  { excludeTags },
);
