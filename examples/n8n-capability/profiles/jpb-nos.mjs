/** JPB business mapping over authenticated nOS -> existing node runner. No SSH fallback. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createJpbPolicy, loadJpbPrograms } from './jpb-policy.mjs';
import { readJpbThroughNos } from './jpb-nos-read.mjs';
import { verifyJpbEvidence } from './jpb-evidence.mjs';
import { createNosNodeClient, invokeNosProgram, writeNosEvidence } from '../nos-node-transport.mjs';

export function createJpbNosProfile(session) {
  if (!session) throw new Error('Configure the account-bound nOS Studio session.');
  if (typeof session.runnerBindingRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session.runnerBindingRevision))
    throw new Error('Configure runnerBindingRevision and change it whenever the underlying nOS runner binding changes.');
  const policy = createJpbPolicy(loadJpbPrograms().filter(p => p.id === 'JPB PLCA - Calculate mapped demo v1.0.0'));
  // Pin the same trusted connection snapshot used for every transport call.
  const connection = Object.freeze({ accountId: session.accountId, controlPlaneUrl: session.controlPlaneUrl,
    runnerBindingRevision: session.runnerBindingRevision, secret: session.secret });
  const revision = createHash('sha256').update(policy.revision).update(JSON.stringify({ accountId: connection.accountId,
    controlPlaneUrl: connection.controlPlaneUrl, runnerBindingRevision: connection.runnerBindingRevision }));
  for (const file of ['./jpb-nos.mjs', './jpb-nos-read.mjs', '../nos-node-transport.mjs', '../nos-studio-session.mjs'])
    revision.update(readFileSync(new URL(file, import.meta.url)));
  return {
    ...policy, id: 'dmaast-jpb-nos', revision: revision.digest('hex'),
    requiresNosActor: true, accountId: connection.accountId,
    async authorize(actor) { await createNosNodeClient(connection, actor)('status'); },
    async transport(payload, operation, { actor } = {}) {
      const call = createNosNodeClient(connection, actor);
      if (operation === 'read') return readJpbThroughNos(call, payload);
      if (operation === 'invoke') return invokeNosProgram(call, payload);
      if (operation === 'write') {
        verifyJpbEvidence(payload);
        return writeNosEvidence(call, payload, policy.targetGraph);
      }
      throw new Error('Unknown DKG operation.');
    },
  };
}
export const createProfile = ({ session }) => createJpbNosProfile(session);
