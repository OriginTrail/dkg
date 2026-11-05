/** JPB business mapping over authenticated nOS -> existing node runner. No SSH fallback. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import jpb from './jpb.mjs';
import { readJpbThroughNos } from './jpb-nos-read.mjs';
import { nosStudioSession } from '../nos-studio-session.mjs';
import { createNosNodeClient, invokeNosProgram, writeNosEvidence } from '../nos-node-transport.mjs';
if (!nosStudioSession) throw new Error('Configure the account-bound nOS Studio session.');
const programs = jpb.programs.filter(p => p.id === 'JPB PLCA - Calculate mapped demo v1.0.0');
const catalogRevision = createHash('sha256').update(JSON.stringify(programs)).digest('hex').slice(0, 16);
const revision = createHash('sha256').update(jpb.revision).update(nosStudioSession.accountId);
for (const file of ['./jpb-nos.mjs', './jpb-nos-read.mjs', '../nos-node-transport.mjs', '../nos-studio-session.mjs'])
  revision.update(readFileSync(new URL(file, import.meta.url)));
export default {
  ...jpb, id: 'dmaast-jpb-nos', revision: revision.digest('hex'),
  programs, catalogRevision,
  parameters: { ...jpb.parameters, 'invoke-dkg-program': { ...jpb.parameters['invoke-dkg-program'],
    program: { ...jpb.parameters['invoke-dkg-program'].program, default: programs[0].id, options: programs.map(p => p.id) },
    catalogRevision: { ...jpb.parameters['invoke-dkg-program'].catalogRevision, default: catalogRevision, options: [catalogRevision] } } },
  requiresNosActor: true, accountId: nosStudioSession.accountId,
  async authorize(actor) { await createNosNodeClient(nosStudioSession, actor)('status'); },
  async transport(payload, operation, { actor } = {}) {
    const call = createNosNodeClient(nosStudioSession, actor);
    if (operation === 'read') return readJpbThroughNos(call, payload);
    if (operation === 'invoke') return invokeNosProgram(call, payload);
    if (operation === 'write') return writeNosEvidence(call, payload, jpb.targetGraph);
    throw new Error('Unknown DKG operation.');
  },
};
