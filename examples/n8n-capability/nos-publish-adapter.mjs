import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/**
 * Server integration seam for nOS's existing workflow publisher. The host supplies
 * an authenticated actor, account-bound database and publish(accountId, request).
 * No HTTP identity resolver, credential, SSH fallback or arbitrary node URL lives here.
 * This is NOT the sealed-asset transport expected by the local JPB profile.
 */
export function createNosPublishAdapter({ db, accountId, publish }) {
  if (!text(accountId, 128) || typeof publish !== 'function')
    throw new Error('Configure an account and the existing nOS publisher.');
  db.exec(`CREATE TABLE IF NOT EXISTS nos_studio_publish_requests (
    request_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, principal_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, request_json TEXT NOT NULL, receipt_json TEXT
  )`);
  const active = new Map();
  return {
    async execute(actor, value) {
      // actor comes from the authenticated nOS host, never workflow input or kit selectors.
      if (!actor || actor.accountId !== accountId || actor.role !== 'owner' || !text(actor.id, 200))
        throw fail(
          'NOS_PUBLISH_OWNER_REQUIRED',
          'An authenticated owner of this account must approve publishing.',
        );
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (k) =>
            ![
              'invocationId',
              'blockId',
              'workflowRef',
              'workflowHash',
              'profileRevision',
              'layer',
              'graphName',
              'assetName',
              'nquads',
            ].includes(k),
        ) ||
        !text(value.invocationId, 36) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          value.invocationId ?? '',
        ) ||
        !text(value.blockId, 128) ||
        !text(value.workflowRef, 2048) ||
        !sha(value.workflowHash) ||
        !sha(value.profileRevision) ||
        !['working-memory', 'verifiable-memory'].includes(value.layer) ||
        !text(value.graphName, 120) ||
        !value.graphName.trim() ||
        !text(value.assetName, 80) ||
        !value.assetName.trim() ||
        !text(value.nquads, 65536) ||
        Buffer.byteLength(value.nquads) > 65536
      )
        throw fail(
          'NOS_PUBLISH_INPUT_INVALID',
          'Supply pinned workflow evidence and an explicit publish layer.',
        );
      actor = { id: actor.id, accountId: actor.accountId, role: actor.role };
      value = { ...value, invocationId: value.invocationId.toLowerCase() };
      // Content is deliberately NOT part of this id: changed content must conflict,
      // not allocate a second publication under the same invocation/block identity.
      const requestId = 'studio-' + hash([accountId, value.invocationId, value.blockId]);
      const request = {
        requestId,
        approvedBy: actor.id,
        layer: value.layer,
        graphName: value.graphName,
        assetName: value.assetName,
        nquads: value.nquads,
      };
      const fingerprint = hash([
        request,
        value.workflowRef,
        value.workflowHash,
        value.profileRevision,
      ]);
      const old = db
        .prepare('SELECT * FROM nos_studio_publish_requests WHERE request_id=?')
        .get(requestId);
      if (
        old &&
        (old.account_id !== accountId ||
          old.principal_id !== actor.id ||
          old.fingerprint !== fingerprint)
      )
        throw fail(
          'NOS_PUBLISH_REVISION_CONFLICT',
          'This invocation already belongs to different approved content or scope.',
        );
      if (old?.receipt_json) return JSON.parse(old.receipt_json);
      // Commit the approved request before dispatch; retries use these same bytes.
      if (!old)
        db.prepare('INSERT INTO nos_studio_publish_requests VALUES (?,?,?,?,?,NULL)').run(
          requestId,
          accountId,
          actor.id,
          fingerprint,
          JSON.stringify(request),
        );
      if (active.has(requestId)) return active.get(requestId);
      const pending = (async () => {
        const view = await publish(
          accountId,
          JSON.parse(old?.request_json ?? JSON.stringify(request)),
        );
        if (
          !view ||
          !['running', 'saved', 'published', 'failed'].includes(view.state) ||
          !(view.actionId === null || text(view.actionId, 1024)) ||
          !(view.message === null || text(view.message, 2000)) ||
          !(view.node === null || (text(view.node?.jobId, 128) && text(view.node?.name, 300))) ||
          !(
            view.asset === null ||
            (text(view.asset?.name, 300) &&
              text(view.asset?.graphId, 2048) &&
              text(view.asset?.graphName, 120) &&
              (view.asset.ual === null || text(view.asset.ual, 2048)))
          )
        )
          throw fail(
            'NOS_PUBLISH_UNCONFIRMED',
            'The nOS publish receipt is invalid; retry this same request.',
          );
        const complete = view.state === 'saved' || view.state === 'published';
        if (
          complete &&
          (!text(view.node?.jobId, 128) ||
            !text(view.node?.name, 300) ||
            !text(view.asset?.name, 300) ||
            !text(view.asset?.graphId, 2048) ||
            !text(view.asset?.graphName, 120) ||
            !(view.asset.ual === null || text(view.asset.ual, 2048)) ||
            (value.layer === 'working-memory'
              ? view.state !== 'saved'
              : view.state !== 'published'))
        )
          throw fail(
            'NOS_PUBLISH_UNCONFIRMED',
            'The nOS receipt does not confirm the requested layer.',
          );
        const receipt = {
          requestId,
          invocationId: value.invocationId,
          blockId: value.blockId,
          accountId,
          approvedBy: actor.id,
          workflowRef: value.workflowRef,
          workflowHash: value.workflowHash,
          profileRevision: value.profileRevision,
          contentHash: createHash('sha256').update(value.nquads).digest('hex'),
          layer: value.layer,
          state: view.state,
          actionId: view.actionId,
          node: view.node ? { jobId: view.node.jobId, name: view.node.name } : null,
          asset: view.asset
            ? {
                name: view.asset.name,
                graphId: view.asset.graphId,
                graphName: view.asset.graphName,
                ual: view.asset.ual,
              }
            : null,
          message: view.message,
          // A WM draft is not a sealed assertion. Do not invent sealed/readback proof.
          ...(view.state === 'saved' ? { storageState: 'working-memory-draft' } : {}),
        };
        if (complete || view.state === 'failed')
          db.prepare(
            'UPDATE nos_studio_publish_requests SET receipt_json=? WHERE request_id=?',
          ).run(JSON.stringify(receipt), requestId);
        return receipt;
      })();
      active.set(requestId, pending);
      try {
        return await pending;
      } finally {
        active.delete(requestId);
      }
    },
  };
}
