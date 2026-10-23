// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';

const exec = promisify(execFile);
const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 120_000 })).stdout.trim();

/** Own a separate container: never restart the shared BLAZEGRAPH_TEST_URL service. */
export async function verifyBlazegraphAcknowledgedPersistence(): Promise<void> {
  const metadata = JSON.parse(await readFile(new URL('../../../../blazegraph-image.json', import.meta.url), 'utf8'));
  const name = `dkg-blazegraph-persistence-${randomUUID()}`;
  const dir = await mkdtemp(join(tmpdir(), 'dkg-blazegraph-policy-'));
  let created = false, store: BlazegraphStore | undefined;
  try {
    await docker('run', '-d', '--name', name, '--label', 'dkg.test=blazegraph-persistence',
      '-p', `127.0.0.1::${metadata.containerPort}`, metadata.image);
    created = true;
    const binding = await docker('port', name, `${metadata.containerPort}/tcp`);
    let endpoint = `http://${binding}/bigdata/namespace/kb/sparql`;
    const ready = async () => {
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const response = await fetch(`${endpoint}?query=${encodeURIComponent('ASK { ?s ?p ?o }')}`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) return;
        } catch { /* Wait for the owned servlet to reopen its journal. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Owned Blazegraph did not become ready');
    };
    await ready();
    // Read the deployed webapp's configuration and the actual loaded library default.
    // This fails if an image change makes acknowledged commits non-durable.
    const webXml = await docker('exec', name, 'cat', '/opt/tomcat/webapps/bigdata/WEB-INF/web.xml');
    assert.match(webXml, /<param-name>propertyFile<\/param-name>\s*<param-value>RWStore.properties<\/param-value>/);
    const java = join(dir, 'JournalPolicy.java');
    await writeFile(java, `import java.util.Properties;
import com.bigdata.journal.Options;
public class JournalPolicy {
 public static void main(String[] args) throws Exception {
  Properties p = new Properties();
  try (var in = JournalPolicy.class.getClassLoader().getResourceAsStream("RWStore.properties")) { p.load(in); }
  System.out.println("bufferMode=" + p.getProperty(Options.BUFFER_MODE, Options.DEFAULT_BUFFER_MODE));
  System.out.println("forceOnCommit=" + p.getProperty(Options.FORCE_ON_COMMIT, Options.DEFAULT_FORCE_ON_COMMIT));
  System.out.println("defaultForceOnCommit=" + Options.DEFAULT_FORCE_ON_COMMIT);
  System.out.println("file=" + p.getProperty(Options.FILE));
 }
}`);
    await docker('cp', java, `${name}:/tmp/JournalPolicy.java`);
    const policy = await docker('exec', name, 'java', '-cp',
      '/opt/tomcat/webapps/bigdata/WEB-INF/classes:/opt/tomcat/webapps/bigdata/WEB-INF/lib/*', '/tmp/JournalPolicy.java');
    assert.match(policy, /^bufferMode=DiskRW$/m);
    assert.match(policy, /^forceOnCommit=ForceMetadata$/m);
    assert.match(policy, /^defaultForceOnCommit=ForceMetadata$/m);
    assert.match(policy, /^file=\/data\/bigdata.jnl$/m);
    store = new BlazegraphStore(endpoint);
    const commitment = store.commitment;
    assert.ok(commitment);
    assert.equal(commitment.durability, 'restart-durable');
    const cases = [
      { subject: 'urn:update', value: '"acknowledged update"',
        write: () => store!.update('INSERT DATA { GRAPH <urn:durability> { <urn:update> <urn:value> "acknowledged update" } }') },
      { subject: 'urn:nquads', value: '"acknowledged N-Quads"',
        write: () => store!.insert([{ subject: 'urn:nquads', predicate: 'urn:value', object: '"acknowledged N-Quads"', graph: 'urn:durability' }]) },
    ];
    for (const scenario of cases) {
      const commit = store.commitment!.capture();
      await scenario.write();
      await commit();
      // This write must be the last mutation: a later commit could mask a premature ACK.
      await docker('kill', '--signal', 'KILL', name);
      assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', name), '137');
      await docker('start', name);
      endpoint = `http://${await docker('port', name, `${metadata.containerPort}/tcp`)}/bigdata/namespace/kb/sparql`;
      await ready(); await store.close(); store = new BlazegraphStore(endpoint);
      assert.deepEqual(await store.query(`SELECT ?o WHERE { GRAPH <urn:durability> { <${scenario.subject}> <urn:value> ?o } }`), {
        type: 'bindings', variables: ['o'], bindings: [{ o: scenario.value }],
      });
      console.log(`Independent acknowledged-write SIGKILL/reopen passed: ${scenario.subject}`);
    }
    console.log(`Blazegraph acknowledged-write SIGKILL/reopen passed: ${metadata.image}; ${policy.replace(/\n/g, '; ')}`);
  } finally {
    await store?.close();
    if (created) {
      assert.equal(await docker('inspect', '--format', '{{index .Config.Labels "dkg.test"}}', name), 'blazegraph-persistence');
      await docker('rm', '-f', '-v', name);
    }
    await rm(dir, { recursive: true, force: true });
  }
}
