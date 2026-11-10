import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const profile = fileURLToPath(new URL('./test-support/measurement-profile.mjs', import.meta.url));
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'component-install-')), cli = join(state, 'fixture-cli.mjs');
  // Fake only the external CLI. The real installer, templates, manifest and SQLite
  // verification all run unchanged in a fresh process for each invocation.
  writeFileSync(cli, `
    import {mkdirSync,readFileSync,readdirSync} from 'node:fs';
    import {join} from 'node:path'; import {DatabaseSync} from 'node:sqlite';
    const dir=join(process.env.N8N_USER_FOLDER,'.n8n');mkdirSync(dir,{recursive:true});
    const db=new DatabaseSync(join(dir,'database.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS workflow_entity(id TEXT PRIMARY KEY,nodes TEXT,connections TEXT,settings TEXT,activeVersionId TEXT)');
    const args=process.argv.slice(2);
    if(args[0]==='import:workflow') {
      const input=args.find(a=>a.startsWith('--input=')).slice(8);
      for(const file of readdirSync(input)) {
        const w=JSON.parse(readFileSync(join(input,file),'utf8'));
        if(process.env.FIXTURE_SKIP_COMPONENT && w.id.startsWith(process.env.FIXTURE_SKIP_COMPONENT))continue;
        db.prepare('INSERT OR REPLACE INTO workflow_entity VALUES(?,?,?,?,NULL)').run(w.id,JSON.stringify(w.nodes),JSON.stringify(w.connections),JSON.stringify(w.settings??{}));
      }
      console.log('Successfully imported workflows');
    } else if(args[0]==='publish:workflow') {
      db.prepare('UPDATE workflow_entity SET activeVersionId=? WHERE id=?').run('published',args.find(a=>a.startsWith('--id=')).slice(5));
      console.log('Publishing workflow');
    } else throw new Error('Unsupported fixture command');
    db.close();
  `);
  const manifestFile = join(state, 'components.json');
  const run = (only, selectedProfile, extraEnv = {}) => {
    const env = { ...process.env, ...extraEnv }; delete env.NOS_DKG_PROFILE_MODULE; delete env.NOS_STUDIO_SESSION_FILE;
    if (selectedProfile) env.NOS_DKG_PROFILE_MODULE = selectedProfile;
    const result = execFileSync(process.execPath, [fileURLToPath(new URL('./setup-components-local.mjs', import.meta.url)), state,
      '--fixture', '--install', '--n8n-cli', cli, ...(only ? ['--only', only] : [])], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(result);
  };
  const native = () => {
    const db = new DatabaseSync(join(state, 'n8n/.n8n/database.sqlite'), { readOnly: true });
    try { return new Map(db.prepare('SELECT * FROM workflow_entity').all().map(row => [row.id, row])); } finally { db.close(); }
  };
  return { state, run, native, manifestFile, manifest: () => JSON.parse(readFileSync(manifestFile, 'utf8')),
    close: () => rmSync(state, { recursive: true, force: true }) };
}

test('partial profile installation adds Read/Write while preserving unselected components and their pins', () => {
  const f = fixture();
  try {
    f.run();
    const original = f.manifest().components, native = f.native();
    assert.equal(original.length, 31);
    assert.equal(f.run('dkg-read,dkg-write', profile).prepared, 2);
    const installed = f.manifest().components;
    assert.equal(installed.length, 33);
    assert.equal(installed.some(c => c.descriptor.id === 'invoke-dkg-program'), false);
    for (const old of original) {
      assert.deepEqual(installed.find(c => c.kaRef === old.kaRef), old);
      assert.deepEqual(f.native().get(old.grant.workflowId), native.get(old.grant.workflowId));
    }
    const write = installed.find(c => c.descriptor.id === 'dkg-write');
    const oldRead = installed.find(c => c.descriptor.id === 'dkg-read');
    const changedProfile = join(f.state, 'changed-profile.mjs');
    writeFileSync(changedProfile, `import p from ${JSON.stringify(new URL('./test-support/measurement-profile.mjs', import.meta.url).href)};export default {...p,revision:'${'d'.repeat(64)}'};`);
    f.run('dkg-read', changedProfile);
    const updated = f.manifest().components;
    assert.deepEqual(updated.find(c => c.kaRef === write.kaRef), write);
    assert.deepEqual(updated.find(c => c.kaRef === oldRead.kaRef), { ...oldRead, retired: true });
    assert.equal(updated.filter(c => c.descriptor.id === 'dkg-read' && !c.retired).length, 1);
    assert.equal(updated.some(c => c.descriptor.id === 'invoke-dkg-program'), false);
    assert.ok(readdirSync(f.state).some(file => file.startsWith('n8n-before-components-')));
  } finally { f.close(); }
});

test('partial installation verifies selected components before replacing the manifest and rejects unknown ids', () => {
  const f = fixture();
  try {
    f.run('dkg-read,dkg-write', profile);
    assert.deepEqual(f.manifest().components.map(c => c.descriptor.id).sort(), ['dkg-read', 'dkg-write']);
    const before = readFileSync(f.manifestFile, 'utf8');
    assert.throws(() => f.run('invoke-dkg-program', profile, { FIXTURE_SKIP_COMPONENT: 'nos_invoke_dkg_program_' }), /Native component was not stored: invoke-dkg-program/);
    assert.equal(readFileSync(f.manifestFile, 'utf8'), before);
    assert.throws(() => f.run('dkg-read,unknown', profile), /known component ids/);
    assert.equal(readFileSync(f.manifestFile, 'utf8'), before);
    f.run('invoke-dkg-program', profile);
    assert.deepEqual(f.manifest().components.map(c => c.descriptor.id).sort(), ['dkg-read', 'dkg-write', 'invoke-dkg-program']);
  } finally { f.close(); }
});
