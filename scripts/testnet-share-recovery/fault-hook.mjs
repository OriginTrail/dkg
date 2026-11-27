// Test-only preload: same compiled-store boundary and one-shot faults for both arms.
// No product source changes. Launch only the owned daemon with this preload.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// Resolve against the launched runtime, never against this harness checkout.
const runtimeRoot = fs.realpathSync(process.env.DKG_TEST_RUNTIME_ROOT ?? process.cwd());
if (runtimeRoot !== fs.realpathSync(process.cwd())) throw new Error('Fault runtime must match the daemon working directory');
const storageModule = path.join(runtimeRoot, 'packages/storage/dist/index.js');
const coreModule = path.join(runtimeRoot, 'packages/core/dist/index.js');
const { BlazegraphStore, StoreSchedulerBusyError } = await import(pathToFileURL(storageModule).href);
const { assertionLifecycleUri, contextGraphAssertionUri, contextGraphMetaUri } = await import(pathToFileURL(coreModule).href);
const home = process.env.DKG_HOME;
if (home) fs.writeFileSync(path.join(home, `2963-fault-runtime-${process.pid}.json`), JSON.stringify({
  at: new Date().toISOString(), pid: process.pid, runtimeRoot,
  modules: [storageModule, coreModule].map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
}), { mode: 0o600 });
const armFile = home && path.join(home, '2963-faults.json');
const insert = BlazegraphStore.prototype.insert;
BlazegraphStore.prototype.insert = async function(quads, ...args) {
  if (armFile && fs.existsSync(armFile)) {
    const faults = JSON.parse(fs.readFileSync(armFile, 'utf8'));
    for (const fault of faults) {
      const subject = assertionLifecycleUri(fault.contextGraphId, fault.agentAddress, fault.name);
      if (!quads.some(q => q.subject === subject && q.predicate === 'http://dkg.io/ontology/state' && q.object === '"promoted"')) continue;
      const fired = path.join(home, `2963-fault-${fault.name}.json`);
      let fd;
      try { fd = fs.openSync(fired, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      const evidence = { ...fault, boundary: 'lifecycle-promoted-insert-before-dispatch', firedAt: new Date().toISOString(), pid: process.pid, intendedMetadataInsert: quads };
      try {
        const seal = contextGraphAssertionUri(fault.contextGraphId, fault.agentAddress, fault.name);
        const graph = contextGraphMetaUri(fault.contextGraphId);
        evidence.metadataAtFault = await this.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { VALUES ?s { <${subject}> <${seal}> } ?s ?p ?o } }`);
        const swm = quads.find(q => q.subject === subject && q.predicate === 'http://dkg.io/ontology/assertionGraph')?.object;
        if (swm) evidence.contentAtFault = await this.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swm}> { ?s ?p ?o } }`);
      } catch (e) { evidence.captureError = e.message; }
      fs.writeFileSync(fd, JSON.stringify(evidence));
      fs.fsyncSync(fd); fs.closeSync(fd);
      if (fault.kind === 'process-exit') process.exit(86);
      if (fault.kind === 'typed-not-started') throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test.2963.lifecyclePromotedInsert', { storeOperation: 'insert' });
      throw new Error('Injected 2963 lifecycle insert dependency outage');
    }
  }
  return insert.call(this, quads, ...args);
};
