/**
 * Syslog TCP push worker — streams structured log entries to a remote
 * syslog receiver (Graylog) over a persistent TCP connection.
 *
 * Uses RFC 5424 syslog format with structured data to carry DKG-specific
 * fields (operation_id, operation_name, module, network, node_name).
 * Reconnects automatically on connection loss.
 *
 * TODO: upgrade to TLS (RFC 5425) once the Graylog Syslog input is
 * reconfigured as a "Syslog TLS" input with the domain certificate.
 */

import { Socket } from 'node:net';

const RECONNECT_DELAY_MS = 5_000;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_BUFFER = 500;

const SYSLOG_SEVERITY: Record<string, number> = {
  error: 3,   // err
  warn: 4,    // warning
  info: 6,    // informational
  debug: 7,   // debug
};

const FACILITY_LOCAL0 = 16;

export interface LogPushWorkerOptions {
  /** Syslog host, e.g. loggly.origin-trail.network */
  host: string;
  /** Syslog TCP port, e.g. 614 */
  port: number;
  /** Node's libp2p peer ID */
  peerId: string;
  /** Network identifier: 'testnet' or 'mainnet' */
  network: string;
  /** Node name from config */
  nodeName?: string;
  /** Semver version from package.json, e.g. "9.0.0-beta.2" */
  version?: string;
  /** Short git commit SHA of the running code, e.g. "a1b2c3d8" */
  commit?: string;
  /** Node role: "core" or "edge" */
  role?: string;
  /** Whether auto-update is enabled */
  autoUpdate?: boolean;
}

interface LogEntry {
  level: string;
  operationName: string;
  operationId: string;
  module: string;
  message: string;
}

/** Escape RFC 5424 SD-PARAM values: \, ", ] must be backslash-escaped. */
function sdEscape(val: string): string {
  return val.replace(/[\\\]"]/g, c => '\\' + c);
}

export class LogPushWorker {
  private buffer: LogEntry[] = [];
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private stopped = false;
  private readonly host: string;
  private readonly port: number;
  private readonly peerId: string;
  private readonly network: string;
  private readonly nodeName: string;
  private readonly version: string;
  private readonly commit: string;
  private readonly role: string;
  private readonly autoUpdate: string;

  constructor(opts: LogPushWorkerOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.peerId = opts.peerId;
    this.network = opts.network;
    this.nodeName = opts.nodeName ?? 'dkg-node';
    this.version = opts.version ?? '';
    this.commit = opts.commit ?? '';
    this.role = opts.role ?? '';
    this.autoUpdate = opts.autoUpdate ? 'on' : 'off';
  }

  push(entry: LogEntry): void {
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
    this.buffer.push(entry);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.connect();
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.flush();
    this.socket?.end();
    this.socket = null;
    this.connected = false;
  }

  private connect(): void {
    if (this.socket || this.stopped) return;

    const sock = new Socket();
    sock.setKeepAlive(true, 30_000);

    sock.connect(this.port, this.host, () => {
      this.connected = true;
      this.flush();
    });

    sock.on('error', () => { /* handled by close */ });
    sock.on('close', () => {
      this.connected = false;
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });

    this.socket = sock;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  private flush(): void {
    if (!this.connected || !this.socket || this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    const ts = new Date().toISOString();

    for (const entry of batch) {
      const pri = FACILITY_LOCAL0 * 8 + (SYSLOG_SEVERITY[entry.level] ?? 6);
      const extra = [
        this.version ? `ver="${sdEscape(this.version)}"` : '',
        this.commit ? `commit="${sdEscape(this.commit)}"` : '',
        this.role ? `role="${sdEscape(this.role)}"` : '',
        `autoUpd="${this.autoUpdate}"`,
      ].filter(Boolean).join(' ');
      const sd = `[dkg@0 peer="${sdEscape(this.peerId)}" op="${sdEscape(entry.operationName)}" opid="${sdEscape(entry.operationId)}" mod="${sdEscape(entry.module)}" net="${sdEscape(this.network)}" ${extra}]`;
      const msg = entry.message.replace(/[\r\n]+/g, ' ').slice(0, 8192);
      const hostname = this.nodeName.replace(/\s+/g, '-');
      const line = `<${pri}>1 ${ts} ${hostname} dkg-v9 - - ${sd} ${msg}\n`;

      try {
        this.socket.write(line);
      } catch {
        // Connection lost mid-flush — remaining entries stay in buffer
        this.buffer.unshift(...batch.slice(batch.indexOf(entry)));
        break;
      }
    }
  }
}
