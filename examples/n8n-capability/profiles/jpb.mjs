/** Explicit opt-in SSH transport for the shared JPB policy. No contact at import. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { remote, remoteScripts } from '../jpb-output.mjs';
import { createJpbPolicy } from './jpb-policy.mjs';

const policy = createJpbPolicy();
const revision = createHash('sha256').update(policy.revision);
for (const file of ['./jpb.mjs', '../jpb-output.mjs', '../jpb-read.py', '../jpb-write.py', '../jpb-invoke-program.py'])
  revision.update(file.endsWith('.py') ? remoteScripts[file.slice(3)] : readFileSync(new URL(file, import.meta.url)));
export default {
  ...policy, id: 'dmaast-jpb', revision: revision.digest('hex'),
  transport(payload, operation) {
    const script = { read: 'jpb-read.py', invoke: 'jpb-invoke-program.py', write: 'jpb-write.py' }[operation];
    if (!script) throw Object.assign(new Error('Unknown DKG operation.'), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' });
    return remote(payload, script);
  },
};
