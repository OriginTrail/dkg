// Integration tests for `probe` against a real Kafka broker (via
// testcontainers). Docker is required.
//
// Gating: set `DKG_KAFKA_INTEGRATION=0` to skip locally if Docker isn't
// available. Defaults to running in any environment that has Docker — we
// don't want a missing flag to silently bypass coverage.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe } from '../../src/kafka-probe.js';
import {
  startPlaintextKafka,
  type PlaintextKafka,
} from '../helpers/kafka-container.js';
import { createTopicAndProduce } from '../helpers/synthetic-producer.js';

const SKIP =
  process.env.DKG_KAFKA_INTEGRATION === '0' ||
  process.env.DKG_KAFKA_INTEGRATION === 'false';

const VITEST_TIMEOUT = 180_000;

describe.skipIf(SKIP)('kafka-probe integration (PLAINTEXT)', () => {
  let kafka: PlaintextKafka;
  const presentTopic = 'probe-present';

  beforeAll(async () => {
    kafka = await startPlaintextKafka();
    await createTopicAndProduce({ bootstrap: kafka.bootstrap, topic: presentTopic });
  }, VITEST_TIMEOUT);

  afterAll(async () => {
    if (kafka) await kafka.stop();
  }, VITEST_TIMEOUT);

  it('verified: topic exists on the broker', async () => {
    const result = await probe({
      brokers: [kafka.bootstrap],
      topic: presentTopic,
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('verified');
    expect(result.error).toBeUndefined();
    expect(Number.isNaN(Date.parse(result.probedAt))).toBe(false);
  }, VITEST_TIMEOUT);

  it('failed: topic does not exist on the broker', async () => {
    const result = await probe({
      brokers: [kafka.bootstrap],
      topic: 'absent-topic-' + Date.now(),
      securityProtocol: 'PLAINTEXT',
    });
    // Either the broker says "topic absent in metadata" → 'failed', or it
    // throws a protocol error (kafka image version-dependent) → also 'failed'.
    expect(result.status).toBe('failed');
  }, VITEST_TIMEOUT);

  it('unreachable: wrong port', async () => {
    // Map a port that is almost certainly closed on the host.
    const result = await probe({
      brokers: ['127.0.0.1:1'],
      topic: presentTopic,
      securityProtocol: 'PLAINTEXT',
      timeoutMs: 3_000,
    });
    expect(['unreachable', 'failed']).toContain(result.status);
    // Whatever surfaces, it's classified, never the raw error message.
    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/127\.0\.0\.1/);
  }, VITEST_TIMEOUT);

  it('credential discarding: SASL creds passed against PLAINTEXT broker → no creds in result', async () => {
    // The broker we spin up is PLAINTEXT, so a SASL_PLAINTEXT probe will
    // fail at the connection layer. We want to verify that the failure
    // result carries no credential substrings.
    const result = await probe({
      brokers: [kafka.bootstrap],
      topic: presentTopic,
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: { mechanism: 'plain', username: 'INTEG-USER-MARKER', password: 'INTEG-PASS-MARKER' },
      timeoutMs: 5_000,
    });
    expect(['failed', 'unreachable']).toContain(result.status);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain('INTEG-USER-MARKER');
    expect(blob).not.toContain('INTEG-PASS-MARKER');
  }, VITEST_TIMEOUT);
});

// SASL_SSL coverage is deferred — wiring up a TLS-enabled broker via
// testcontainers requires generating a JKS keystore, plumbing it as a SASL
// SSL listener, and bouncing the broker. The kafka-container helper has a
// `withSaslSslListener` option but the certificate plumbing exceeds the
// "straightforward" bar called out in the slice's acceptance criteria. The
// SASL_SSL config-wiring branch is exercised in the unit tests
// (`test/kafka-probe.test.ts`); the integration coverage stays PLAINTEXT-only
// for this slice.
//
// Follow-up tracking: extend this file with a `describe.skipIf(SKIP)` block
// that drives a SASL_SSL listener once we have a fixture certificate
// generator we trust.
