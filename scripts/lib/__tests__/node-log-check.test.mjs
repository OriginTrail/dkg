import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeNodeLog } from '../qa/node-log-check.mjs';

const CLI = fileURLToPath(new URL('../qa/node-log-check.mjs', import.meta.url));
const STAMP = '20261013T101457Z-88064';
// What every node logs about a run: the graph it subscribed to and the reads it served.
const about = `[subscribe] contextGraph=0xabc/issue-3198-oxigraph-${STAMP} includeSharedMemory=true`;
const at = (time, text) => `2026-10-13 ${time} system 3fa7e02c [DKGAgent] ${text} [WARN]`;
const repair = (attempt, consecutive) => at('12:00:19',
  `{"event":"catalog_repair_failed","diagnostic":{"kind":"unknown","stage":"unknown"},"attempt":${attempt},"consecutiveFailures":${consecutive},"nextAttemptAtMs":1}`);
const refusedByLimit = at('11:58:22', 'RFC-64 catalog reconciliation failed head=0x33c2 error=Rfc64PublicCatalogNativeReceiverErrorV1 code=catalog-native-receiver-activation cause=NQUADS_BYTE_LIMIT_EXCEEDED detail=[catalog-native-receiver-activation] exact SWM post-read failed');
const refusedByDifference = at('11:58:23', 'RFC-64 catalog reconciliation failed head=0x33c2 detail=exact SWM post-read differs from verified projection for did:dkg:evm:31337/0xabc/1');
const log = (...lines) => `${[about, ...lines].join('\n')}\n`;

test('a log that does not mention the run is no evidence, whatever else it holds', () => {
  for (const text of ['', '\n', 'some other log\n', `${repair(9, 8)}\n`, `${refusedByLimit}\n`, `[subscribe] contextGraph=0xabc/issue-3198-oxigraph-20261013T000000Z-1\n`]) {
    assert.deepEqual(judgeNodeLog(text, { stamp: STAMP, author: true }), { verdict: 'no-evidence', findings: [] }, JSON.stringify(text));
    assert.equal(judgeNodeLog(text, { stamp: STAMP }).verdict, 'no-evidence');
  }
  assert.equal(judgeNodeLog(undefined, { stamp: STAMP }).verdict, 'no-evidence');
  assert.throws(() => judgeNodeLog(log(), { stamp: '' }), /stamp/);
});

test('a log of the run without a defect line is clean', () => {
  assert.deepEqual(judgeNodeLog(log(), { stamp: STAMP, author: true }), { verdict: 'clean', findings: [] });
  assert.deepEqual(judgeNodeLog(log(at('12:00:01', 'Replayed 1 RFC-64 catalog head(s) to yrSqrP2i')), { stamp: STAMP }), { verdict: 'clean', findings: [] });
});

test('an author that fails to repair its catalog twice in a row has the defect; one that recovers has a note', () => {
  const stuck = judgeNodeLog(log(repair(4, 1), repair(5, 2), repair(6, 3)), { stamp: STAMP, author: true });
  assert.equal(stuck.verdict, 'defect');
  assert.deepEqual(stuck.findings.map(f => [f.kind, f.count]), [['repair-failed-repeatedly', 3]]);
  assert.match(stuck.findings[0].sample, /"consecutiveFailures":2/);
  // Ten or more in a row are still more than one.
  assert.equal(judgeNodeLog(log(repair(30, 16)), { stamp: STAMP, author: true }).verdict, 'defect');

  // What a healthy full run shows now and then: a retry that then succeeded.
  const recovered = judgeNodeLog(log(repair(3, 0), repair(87, 1)), { stamp: STAMP, author: true });
  assert.equal(recovered.verdict, 'clean');
  assert.deepEqual(recovered.findings.map(f => [f.kind, f.count]), [['repair-failed-recovered', 2]]);
  // A node that authored nothing in the run is not judged as an author.
  assert.deepEqual(judgeNodeLog(log(repair(5, 2)), { stamp: STAMP, author: false }), { verdict: 'clean', findings: [] });
});

test('a refused read-back is a defect on any node, in each of its wordings', () => {
  for (const line of [refusedByLimit, refusedByDifference, at('1', 'empty genesis durable post-read differs in head, digest, version, or row count')]) {
    const judged = judgeNodeLog(log(line), { stamp: STAMP });
    assert.equal(judged.verdict, 'defect', line);
    assert.deepEqual(judged.findings.map(f => [f.kind, f.count, f.sample]), [['read-back-refused', 1, line]]);
  }
  const both = judgeNodeLog(log(repair(5, 2), refusedByLimit, refusedByLimit), { stamp: STAMP, author: true });
  assert.deepEqual(both.findings.map(f => [f.kind, f.count]), [['repair-failed-repeatedly', 1], ['read-back-refused', 2]]);
  // A recovered retry beside a refusal is still a defect.
  assert.equal(judgeNodeLog(log(repair(3, 1), refusedByLimit), { stamp: STAMP, author: true }).verdict, 'defect');
});

test('the command line prints one line per finding and keeps "no evidence" apart from "clean"', () => {
  const judge = (text, role = 'author', stamp = STAMP) => spawnSync(process.execPath, [CLI, stamp, role], { input: text, encoding: 'utf8' });
  const clean = judge(log());
  assert.equal(clean.status, 0); assert.equal(clean.stdout, 'clean\n');
  const recovered = judge(log(repair(3, 1)));
  assert.equal(recovered.status, 0);
  assert.match(recovered.stdout, /^repair-failed-recovered\t1\t\{"event":"catalog_repair_failed".*\nclean\n$/);
  const stuck = judge(log(repair(4, 1), repair(5, 2), refusedByLimit));
  assert.equal(stuck.status, 1);
  const lines = stuck.stdout.trimEnd().split('\n').map(line => line.split('\t'));
  assert.deepEqual(lines.map(([kind, count]) => [kind, count]), [['repair-failed-repeatedly', '2'], ['read-back-refused', '1']]);
  // The sample is the message, without the prefix every log line has, on one line.
  assert.match(lines[1][2], /^RFC-64 catalog reconciliation failed head=0x33c2 /);
  assert.ok(lines.every(fields => fields.length === 3));
  assert.equal(judge(log(repair(5, 2)), 'receiver').status, 0);

  for (const text of ['', 'another log\n', `${refusedByLimit}\n`]) {
    const none = judge(text);
    assert.equal(none.status, 2, JSON.stringify(text)); assert.equal(none.stdout, 'no-evidence\n');
  }
  assert.equal(judge(log(), 'publisher').status, 2);
  assert.equal(judge(log(), 'author', '').status, 2);
});
