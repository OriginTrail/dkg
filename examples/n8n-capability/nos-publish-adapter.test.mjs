import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNosPublishAdapter } from './nos-publish-adapter.mjs';
const actor = { id: 'owner-a', accountId: 'account-a', role: 'owner' };
const input = {
  invocationId: '11223344-1234-4234-8234-123456789abc',
  blockId: 'write',
  workflowRef: 'urn:workflow:fixture',
  workflowHash: 'a'.repeat(64),
  profileRevision: 'b'.repeat(64),
  layer: 'working-memory',
  graphName: 'Fixture graph',
  assetName: 'Fixture evidence',
  nquads: '<urn:s> <urn:p> "value" .',
};
const saved = {
  actionId: null,
  state: 'saved',
  node: { jobId: 'job-a', name: 'Account node' },
  asset: {
    name: 'fixture-evidence-suffix',
    graphId: 'urn:graph:fixture',
    graphName: 'Fixture graph',
    ual: null,
  },
  message: null,
};
function fixture(publish = async () => saved) {
  const db = new DatabaseSync(':memory:');
  return { db, adapter: createNosPublishAdapter({ db, accountId: actor.accountId, publish }) };
}
test('maps the owner and evidence to the existing nOS publisher and reports a draft honestly', async () => {
  const calls = [],
    f = fixture(async (...args) => {
      calls.push(args);
      return saved;
    });
  try {
    const receipt = await f.adapter.execute(actor, input);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], actor.accountId);
    assert.deepEqual(calls[0][1], {
      requestId: receipt.requestId,
      approvedBy: actor.id,
      layer: input.layer,
      graphName: input.graphName,
      assetName: input.assetName,
      nquads: input.nquads,
    });
    assert.equal(receipt.storageState, 'working-memory-draft');
    assert.equal(receipt.readbackVerified, undefined);
    assert.equal(receipt.status, undefined);
    assert.equal(receipt.asset.name, saved.asset.name);
    assert.deepEqual(await f.adapter.execute(actor, input), receipt);
    assert.deepEqual(
      await f.adapter.execute(actor, { ...input, invocationId: input.invocationId.toUpperCase() }),
      receipt,
    );
    assert.equal(calls.length, 1);
  } finally {
    f.db.close();
  }
});
test('refuses viewers, operators, other accounts and workflow-supplied identity before dispatch', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return saved;
  });
  try {
    for (const bad of [
      null,
      { ...actor, role: 'viewer' },
      { ...actor, role: 'operator' },
      { ...actor, accountId: 'account-b' },
    ])
      await assert.rejects(f.adapter.execute(bad, input), /authenticated owner/);
    for (const patch of [
      { approvedBy: 'other-owner' },
      { accountId: 'account-b' },
      { endpoint: 'https://foreign.invalid' },
      { nodeId: 'foreign-node' },
      { nquads: 'x'.repeat(65537) },
    ])
      await assert.rejects(f.adapter.execute(actor, { ...input, ...patch }), /pinned workflow/);
    assert.equal(calls, 0);
  } finally {
    f.db.close();
  }
});
test('changed content, profile, workflow or principal cannot turn a retry into another write', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return saved;
  });
  try {
    await f.adapter.execute(actor, input);
    for (const patch of [
      { nquads: '<urn:s> <urn:p> "changed" .' },
      { profileRevision: 'c'.repeat(64) },
      { workflowHash: 'd'.repeat(64) },
      { graphName: 'Other graph' },
      { layer: 'verifiable-memory' },
    ])
      await assert.rejects(
        f.adapter.execute(actor, { ...input, ...patch }),
        /different approved content/,
      );
    await assert.rejects(
      f.adapter.execute({ ...actor, id: 'owner-b' }, input),
      /different approved content/,
    );
    await assert.rejects(
      f.adapter.execute({ ...actor, role: 'viewer' }, input),
      /authenticated owner/,
    );
    assert.equal(calls, 1);
  } finally {
    f.db.close();
  }
});
test('persists before dispatch and reopens a lost response using identical request bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nos-publish-adapter-')),
    path = join(dir, 'state.sqlite');
  const calls = [];
  let db = new DatabaseSync(path);
  try {
    const first = createNosPublishAdapter({
      db,
      accountId: actor.accountId,
      publish: async (account, request) => {
        calls.push([account, request]);
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM nos_studio_publish_requests').get().n,
          1,
        );
        throw new Error('lost reply');
      },
    });
    await assert.rejects(first.execute(actor, input), /lost reply/);
    db.close();
    db = new DatabaseSync(path);
    const reopened = createNosPublishAdapter({
      db,
      accountId: actor.accountId,
      publish: async (...args) => {
        calls.push(args);
        return saved;
      },
    });
    await reopened.execute(actor, input);
    assert.deepEqual(calls[1], calls[0]);
    db.close();
    db = new DatabaseSync(path);
    const cached = createNosPublishAdapter({
      db,
      accountId: actor.accountId,
      publish: () => assert.fail('confirmed replay dispatched'),
    });
    assert.equal((await cached.execute(actor, input)).state, 'saved');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('running responses keep the same identity and only confirmed terminal outcomes are cached', async () => {
  const calls = [];
  const f = fixture(async (_account, request) => {
    calls.push(request);
    return calls.length === 1 ? { ...saved, state: 'running' } : saved;
  });
  try {
    assert.equal((await f.adapter.execute(actor, input)).state, 'running');
    assert.equal((await f.adapter.execute(actor, input)).state, 'saved');
    assert.deepEqual(calls[0], calls[1]);
  } finally {
    f.db.close();
  }
});
test('rejects fabricated layer success and shares one concurrent publication', async () => {
  const wrong = fixture(async () => ({ ...saved, state: 'published' }));
  try {
    await assert.rejects(wrong.adapter.execute(actor, input), /requested layer/);
  } finally {
    wrong.db.close();
  }
  let calls = 0,
    release;
  const f = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    const a = f.adapter.execute(actor, input),
      b = f.adapter.execute(actor, input);
    assert.equal(calls, 1);
    release(saved);
    assert.deepEqual(await a, await b);
  } finally {
    f.db.close();
  }
});
test('preserves published and failed outcomes without manufacturing a sealed WM receipt', async () => {
  for (const state of ['published', 'failed']) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return {
        ...saved,
        state,
        actionId: 'action-1',
        asset: { ...saved.asset, ual: state === 'published' ? 'urn:fixture:ual' : null },
        message: state === 'failed' ? 'Publication refused' : null,
      };
    });
    try {
      const request = { ...input, layer: 'verifiable-memory' };
      const receipt = await f.adapter.execute(actor, request);
      assert.equal(receipt.state, state);
      assert.equal(receipt.actionId, 'action-1');
      assert.equal(receipt.storageState, undefined);
      assert.equal(receipt.readbackVerified, undefined);
      assert.deepEqual(await f.adapter.execute(actor, request), receipt);
      assert.equal(calls, 1);
    } finally {
      f.db.close();
    }
  }
});
