import { readFile, open, unlink, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Journal } from './journal.mjs';
import { buildAsset, assetIdentity, hash } from './asset.mjs';
import { readKafka } from './kafka.mjs';
import { createDkgSink } from './dkg-sink.mjs';

/** DKG SourceWorkerHandlerModule; loaded by the native `dkg source-worker` CLI.
 * It deliberately does NOT use createAndShare/publishAsync: this PoC seals only
 * private Working Memory and never promotes or submits chain publication. */
export function createHandler({ read = readKafka, sinkFactory = createDkgSink } = {}) {
  return {
    async createSourceWorkerDeps({ config }) {
      const sink = sinkFactory(config);
      const deliveries = new Map();
      if (new Set(config.sources.map(source => source.id)).size !== config.sources.length)
        throw new Error('KAFKA_SOURCE_ID_REUSED');
      for (const source of config.sources) {
        if (source.kind !== 'kafka') throw new Error('KAFKA_SOURCE_KIND_REQUIRED');
        if (!source.clusterId || !source.groupId || !source.topic || !source.brokers?.length)
          throw new Error('KAFKA_SOURCE_CONFIG_REQUIRED');
        if (!/^0x[0-9a-f]{40}$/i.test(source.agentAddress) ||
            !source.contextGraphId)
          throw new Error('KAFKA_AGENT_AND_GRAPH_REQUIRED');
        if ((source.maxMessages ?? 10) < 1 || (source.maxMessages ?? 10) > 100 ||
            (source.maxBatchBytes ?? 24000) > 24000) throw new Error('KAFKA_BATCH_LIMIT');
      }
      const sourceFor = ref => config.sources.find(source => source.id === ref.id);
      return {
        async getFingerprint(ref) {
          const source = sourceFor(ref);
          const state = await readFile(config.stateFile, 'utf8').then(JSON.parse).catch(error => {
            if (error.code === 'ENOENT') return { sources: {} }; throw error;
          });
          const previous = state.sources[source.id];
          if (previous?.manualReviewRequired || (previous?.attemptCount ?? 0) >= (source.maxRetries ?? 3))
            return previous.fingerprint;
          const prefix = resolve(dirname(config.stateFile), `kafka-${hash(source.id).slice(0, 16)}`);
          // Reject concurrent writers; stale locks need explicit operator review.
          let journal, lock, delivery;
          try {
            await mkdir(dirname(prefix), { recursive: true, mode: 0o700 });
            lock = await open(prefix + '.lock', 'wx', 0o600);
            await lock.writeFile(String(process.pid));
            journal = new Journal(prefix + '.sqlite', hash(source));
            delivery = await read(source, journal);
            const records = delivery.records.map(envelope => {
              const { fetchedAt: _fetchedAt, ...original } = envelope;
              return journal.stage(envelope, hash(original), `kafka-record-${assetIdentity(source, envelope)}`);
            });
            const fingerprint = hash(records.map(record => [record.position, record.digest]));
            deliveries.set(source.id, { delivery, journal, lock, prefix, records, fingerprint });
            return fingerprint;
          } catch (error) {
            await delivery?.close().catch(() => {});
            journal?.close();
            if (lock) { await lock.close(); await unlink(prefix + '.lock'); }
            // Fingerprinting runs outside the native worker processing catch.
            // Defer the sanitized failure to processSource so native retries,
            // manual review and continuation to other sources still apply.
            const failure = new Error(/^KAFKA_[A-Z_]+$/.test(error.message) ? error.message : 'KAFKA_PREPARATION_FAILED');
            const fingerprint = hash([source.id, 'preparation-failed']);
            deliveries.set(source.id, { failure, fingerprint });
            return fingerprint;
          }
        },
        async processSource(ref, fingerprint, _state) {
          const source = sourceFor(ref);
          const current = deliveries.get(source.id);
          if (!current || fingerprint !== current.fingerprint) throw new Error('KAFKA_DELIVERY_REQUIRED');
          if (current.failure) {
            deliveries.delete(source.id);
            throw current.failure;
          }
          const { records, journal, delivery, lock, prefix } = current;
          let created = 0, reused = 0;
          const receipts = [];
          try {
            for (const record of records) {
              const asset = buildAsset(source, record.envelope);
              const receipt = await sink.ensure(source, asset, record, journal);
              journal.verified(record.position, receipt);
              // Offset acknowledgement ALWAYS follows sealed, exact DKG readback.
              await delivery.commit(record.envelope);
              journal.checkpoint(record.envelope.topic, record.envelope.partition,
                (BigInt(record.envelope.offset) + 1n).toString());
              if (receipt.reused) reused++;
              else created++;
              receipts.push(receipt);
            }
            return { sourceId: source.id, skipped: !records.length,
              reason: records.length ? undefined : 'no-matching-rows',
              status: records.length ? 'completed' : 'no-matching-rows',
              nextState: { fingerprint, lastRunAt: new Date().toISOString(),
                lastStatus: records.length ? 'completed' : 'no-matching-rows',
                lastError: undefined, manualReviewRequired: false,
                kafka: { processed: records.length, created, reused, receipts } } };
          } catch (error) {
            if (error.message !== 'DKG_RETRY_LATER') throw error;
            return { sourceId: source.id, skipped: true, reason: 'retry-after',
              nextState: { ..._state, fingerprint, lastRunAt: new Date().toISOString(),
                lastStatus: 'retry-wait', retryAt: error.retryAt } };
          } finally {
            deliveries.delete(source.id);
            await delivery.close().catch(() => {});
            journal.close(); await lock.close(); await unlink(prefix + '.lock');
          }
        },
      };
    },
  };
}

export default createHandler();
