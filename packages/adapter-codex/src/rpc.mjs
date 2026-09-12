import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// One connection owns both turn events and server-initiated approval requests.
// Killing a browser connection must never kill the Codex process or its turn.
export class CodexRpc extends EventEmitter {
  constructor({ binary = 'codex', args = ['app-server'], cwd, env = process.env } = {}) {
    super();
    Object.assign(this, { binary, args, cwd, env });
    this.pending = new Map();
    this.serial = 0;
    this.child = null;
    this.starting = null;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.connect();
    try { return await this.starting; }
    catch (error) { this.starting = null; throw error; }
  }

  async connect() {
    const child = spawn(this.binary, this.args, {
      cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // stderr is intentionally not forwarded to the browser: upstream diagnostics
    // can contain account, provider, or local configuration details.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        this.emit(message.id !== undefined ? 'request' : 'notification', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code }));
        else pending.resolve(message.result);
      }
    });
    const disconnected = (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.starting = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.emit('disconnect', error);
    };
    child.once('error', disconnected);
    child.once('exit', () => disconnected(new Error('Codex disconnected. Reconnect to continue.')));
    const result = await this.request('initialize', {
      clientInfo: { name: 'dkg_node_ui', title: 'DKG Node UI', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false,
        optOutNotificationMethods: ['item/reasoning/textDelta'] },
    }, 15_000);
    this.write({ method: 'initialized', params: {} });
    return result;
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex is not connected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, timeout = 90_000) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. Refresh to check its status before retrying.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  reply(id, result) { this.write({ id, result }); }
  reject(id, message) { this.write({ id, error: { code: -32601, message } }); }
  close() { this.child?.kill('SIGTERM'); }
}
