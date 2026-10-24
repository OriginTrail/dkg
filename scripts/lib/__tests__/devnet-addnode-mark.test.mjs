import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DEVNET = fileURLToPath(new URL('../../devnet.sh', import.meta.url));

/**
 * `devnet.sh addnode 7 edge` with the chain and the daemon stubbed out. The
 * stubbed start records what the node's folder held when the daemon would have
 * started. `meanwhile` runs where addnode waits on the chain, after its first
 * check that the folder does not exist, as another caller might.
 */
function addnode(t, env, { meanwhile = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-addnode-mark-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync('bash', ['-c', `
    source "$1"
    refresh_hardhat_pidfile() { ${meanwhile} echo 1; }
    create_node_config() {
      mkdir -p "$DEVNET_DIR/node$1"
      printf '%s' '{"name":"devnet-node-7","nodeRole":"edge"}' > "$DEVNET_DIR/node$1/config.json"
    }
    start_node() { cat "$DEVNET_DIR/node$1/.mark" > "$DEVNET_DIR/mark-at-start" 2>/dev/null || true; }
    cmd_addnode addnode 7 edge
  `, 'bash', DEVNET], {
    encoding: 'utf8',
    env: { ...process.env, DEVNET_SOURCE_ONLY: '1', DEVNET_DIR: dir, DEVNET_ADDNODE_CONFIG_OVERRIDES: '', ...env },
  });
  const read = file => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : undefined);
  return { dir, status: result.status, output: result.stdout + result.stderr, read };
}

test('addnode writes the caller\'s mark into the new folder before the node starts', t => {
  const { status, output, read } = addnode(t, { DEVNET_ADDNODE_MARK_NAME: '.mark', DEVNET_ADDNODE_MARK_TEXT: 'run-1 member2 starting' });
  assert.equal(status, 0, output);
  assert.equal(read('mark-at-start'), 'run-1 member2 starting\n');
  assert.equal(read('node7/.mark'), 'run-1 member2 starting\n');
  // Without a mark name there is no mark.
  const plain = addnode(t, {});
  assert.equal(plain.status, 0, plain.output);
  assert.equal(plain.read('node7/.mark'), undefined);
});

test('a mark name that is not a file name stops addnode and leaves nothing behind', t => {
  for (const name of ['../escape', 'a/b', '.', '..']) {
    const { status, output, read } = addnode(t, { DEVNET_ADDNODE_MARK_NAME: name, DEVNET_ADDNODE_MARK_TEXT: 'run-1' });
    assert.equal(status, 1, `${name}: ${output}`);
    assert.match(output, /DEVNET_ADDNODE_MARK_NAME must be a file name; node7 was not started/);
    assert.equal(read('node7/config.json'), undefined, name);
    assert.equal(read('mark-at-start'), undefined, name);
  }
});

test('a folder another caller creates after addnode\'s first check is refused and left as it is', t => {
  const { status, output, read } = addnode(t, { DEVNET_ADDNODE_MARK_NAME: '.mark', DEVNET_ADDNODE_MARK_TEXT: 'run-1 member2 starting' },
    { meanwhile: 'mkdir -p "$DEVNET_DIR/node7"; printf theirs > "$DEVNET_DIR/node7/theirs";' });
  assert.equal(status, 1, output);
  assert.match(output, /node7 already exists/);
  assert.equal(read('node7/theirs'), 'theirs');
  assert.equal(read('node7/.mark'), undefined);
  assert.equal(read('node7/config.json'), undefined);
  assert.equal(read('mark-at-start'), undefined);
});
