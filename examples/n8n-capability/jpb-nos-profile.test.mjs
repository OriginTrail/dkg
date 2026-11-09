import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { JPB_WORKBOOK } from './profiles/jpb-evidence.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jpb-nos-profile-')), dir = join(root, 'examples/n8n-capability');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../packages/', import.meta.url)), join(root, 'packages'), 'dir');
  cpSync(fileURLToPath(new URL('./profiles/', import.meta.url)), join(dir, 'profiles'), { recursive: true });
  for (const name of ['jpb-output.mjs', 'jpb-programs.json', 'jpb-read.py', 'jpb-write.py', 'jpb-invoke-program.py', 'nos-node-transport.mjs', 'nos-studio-session.mjs'])
    cpSync(fileURLToPath(new URL('./' + name, import.meta.url)), join(dir, name));
  const sessionFile = join(root, 'session.json'), secretFile = join(root, 'secret'), workbookFile = join(root, 'workbook.json');
  writeFileSync(secretFile, 'fictional-test-service-credential-12345', { mode: 0o600 });
  const config = { accountId: 'test-account', controlPlaneUrl: 'http://127.0.0.1:4610', runnerBindingRevision: 'runner-v1', secretFile };
  const workbook = Array.from({ length: 4 }, (_, row) => ({ row, quantity: 1, allocationStatus: 'unconfirmed', evidence: { contentDigest: JPB_WORKBOOK } }));
  writeFileSync(workbookFile, JSON.stringify([{ workbook }]));
  const configure = changes => writeFileSync(sessionFile, JSON.stringify({ ...config, ...changes }));
  configure({});
  const url = name => pathToFileURL(join(dir, name)).href;
  const run = source => execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NOS_STUDIO_SESSION_FILE: sessionFile, NOS_JPB_WORKBOOK_INPUT_FILE: workbookFile,
      NOS_JPB_READ_ENABLED: '1', NOS_JPB_WRITE_ENABLED: '1' } }).trim();
  const read = (name = 'jpb-nos') => JSON.parse(run(`const {default:p}=await import(${JSON.stringify(url('profiles/' + name + '.mjs'))});
    console.log(JSON.stringify({revision:p.revision,programs:p.programs.map(p=>p.id),choices:p.parameters['invoke-dkg-program'].program.options}));`));
  return { dir, root, url, run, read, configure, secretFile, workbookFile };
}

test('nOS revision pins normalized connection and explicit runner binding, while allowing credential rotation', t => {
  const f = fixture(t), initial = f.read();
  assert.equal(initial.programs.length, 1); assert.deepEqual(initial.choices, initial.programs);
  assert.equal(f.read('jpb').programs.length, 3);
  f.configure({ controlPlaneUrl: 'http://127.0.0.1:4610/' });
  assert.equal(f.read().revision, initial.revision);
  f.configure({ controlPlaneUrl: 'http://127.0.0.1:4611' });
  assert.notEqual(f.read().revision, initial.revision);
  f.configure({ runnerBindingRevision: 'runner-v2' });
  assert.notEqual(f.read().revision, initial.revision);
  f.configure({ accountId: 'other-account' });
  assert.notEqual(f.read().revision, initial.revision);
  f.configure({});
  writeFileSync(f.secretFile, 'rotated-fictional-service-credential-67890');
  assert.equal(f.read().revision, initial.revision);
  for (const runnerBindingRevision of [undefined, '', 'invalid revision']) {
    f.configure({ runnerBindingRevision });
    assert.throws(() => f.read(), /runnerBindingRevision/);
  }
});

test('SSH-only changes cannot alter or prevent nOS profile construction', t => {
  const f = fixture(t), native = f.read().revision, ssh = f.read('jpb').revision;
  appendFileSync(join(f.dir, 'jpb-write.py'), '\n# SSH-only fixture revision\n');
  assert.equal(f.read().revision, native);
  assert.notEqual(f.read('jpb').revision, ssh);
  for (const file of ['jpb-read.py', 'jpb-write.py', 'jpb-invoke-program.py', 'jpb-output.mjs', 'profiles/jpb.mjs'])
    rmSync(join(f.dir, file));
  assert.equal(f.read().revision, native);
  appendFileSync(join(f.dir, 'profiles/jpb-policy.mjs'), '\n// Reviewed common policy change\n');
  assert.notEqual(f.read().revision, native);
});

test('changed nOS connection fences cached reads and pending writes after journal reopen', t => {
  const f = fixture(t);
  const storeUrl = new URL('./test-support/dkg-component-store-fixture.mjs', import.meta.url).href;
  const parametersUrl = new URL('./dkg-profile.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    const { default: original, createJpbNosProfile } = await import(${JSON.stringify(f.url('profiles/jpb-nos.mjs'))});
    const { nosStudioSession } = await import(${JSON.stringify(f.url('nos-studio-session.mjs'))});
    const { dkgComponentStore } = await import(${JSON.stringify(storeUrl)});
    const { profileParameters } = await import(${JSON.stringify(parametersUrl)});
    const actor = { id: 'owner', role: 'owner', accountId: original.accountId };
    const profile = { ...original, authorize: async () => {} }, calls = [];
    const workbook = profile.loadInputs(), id = '11223344-1234-4234-8234-123456789abc';
    const block = (id, componentId) => ({id,componentId,params:Object.fromEntries(Object.entries(profileParameters(profile,componentId)).map(([k,v])=>[k,v.default]))});
    const workflow = {kaRef:'urn:test:connection',sourceHash:'a'.repeat(64),definition:{entryId:'read',nodes:[block('read','dkg-read'),block('write','dkg-write')],edges:[{from:'read',to:'write'}]}};
    const input = {itemsJson:JSON.stringify([{workbook}]),paramsJson:'{}',executionId:''};
    const request = (blockId,items) => ({blockId,items,effectId:'urn:sr:effect:'+id+':0',workflowId:'native',executionId:'42'});
    const graph = profile.parameters['dkg-read'].contextGraph.default;
    const records = ['CUT','USILU','EBAVM'].map(operationCode=>({operationCode,orderNo:'62633',recordId:'urn:test:'+operationCode,evidence:{contextGraphId:graph}}));
    const transport = async (_payload,operation) => { calls.push(operation); if(operation==='read')return{records,source:{contextGraphId:graph}};throw Error('write reply lost'); };
    const file = ${JSON.stringify(join(f.root, 'journal.sqlite'))};
    let db = new DatabaseSync(file);
    const first = dkgComponentStore(db,transport,undefined,profile);
    first.grant(workflow,id,input,actor);
    const read = request('read',JSON.parse(input.itemsJson));
    await first.call(read,workflow,'native');
    const write = request('write',[{erp:records[0],workbook:workbook[0]}]);
    await assert.rejects(first.call(write,workflow,'native'),/write reply lost/);
    db.close();
    for(const change of [{controlPlaneUrl:'http://127.0.0.1:4611'},{runnerBindingRevision:'runner-v2'}]) {
      const next = {...createJpbNosProfile({...nosStudioSession,...change}),authorize:async()=>assert.fail('Changed profile must be rejected before node authorization')};
      assert.notEqual(next.revision,profile.revision);
      db = new DatabaseSync(file);
      try {
        const reopened = dkgComponentStore(db,transport,undefined,next);
        assert.throws(()=>reopened.grant(workflow,id,input,actor),/profile changed/);
        await assert.rejects(reopened.call(read,workflow,'native'),/profile changed/);
        await assert.rejects(reopened.call(write,workflow,'native'),/profile changed/);
        const repinned=structuredClone(workflow);repinned.definition.nodes.forEach(n=>n.params.profileRevision=next.revision);
        assert.throws(()=>reopened.grant(repinned,id,input,actor),/different execution profile/);
        await assert.rejects(reopened.call(read,repinned,'native'),/profile mismatch/);
        await assert.rejects(reopened.call(write,repinned,'native'),/profile mismatch/);
        assert.equal(db.prepare('SELECT result FROM dkg_component_calls WHERE id=?').get(id+':write').result,null);
        assert.deepEqual(calls,['read','write']);
      } finally {db.close();}
    }
    console.log('verified');
  `;
  assert.equal(f.run(source), 'verified');
});
