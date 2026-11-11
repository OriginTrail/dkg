// SPDX-License-Identifier: Apache-2.0
import type { DKGAgentConfig } from '@origintrail-official/dkg-agent';
import { openDaemonCheckpointAgent } from './public-checkpoint-agent.js';
import type { DaemonPublicCheckpointConfig } from './public-checkpoint-config.js';
import { startCheckpointStartupStatus } from './public-checkpoint-status.js';

/** Own startup resources until the normal daemon shutdown handlers take over. */
export class PublicCheckpointStartup {
  private readonly abort = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private session?: Awaited<ReturnType<typeof openDaemonCheckpointAgent>>;
  private status?: Awaited<ReturnType<typeof startCheckpointStartupStatus>>;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private interrupting?: Promise<void>;
  private readonly interrupt = () => {
    this.abort.abort(new Error('Checkpoint startup interrupted'));
    return this.interrupting ??= this.onInterrupted();
  };

  constructor(private readonly onInterrupted: () => Promise<void>) {
    this.timer = setTimeout(() => this.abort.abort(new Error('Checkpoint job deadline exceeded')), 3_600_000);
    // Keep both handlers installed during cleanup, including on repeated signals.
    process.on('SIGTERM', this.interrupt);
    process.on('SIGINT', this.interrupt);
  }

  async open(config: DKGAgentConfig, spec: DaemonPublicCheckpointConfig, mode: 'fresh' | 'resume',
    port: number, host: string | undefined, publishPort: (port: number) => Promise<void>) {
    this.opening = (async () => {
      this.status = await startCheckpointStartupStatus(port, host);
      this.assertActive();
      await publishPort(this.status.port);
      this.assertActive();
      this.session = await openDaemonCheckpointAgent(config, spec, mode, this.abort.signal);
      this.assertActive();
    })();
    await this.opening;
    return this.session!.agent;
  }

  get port() { return this.status?.port; }
  assertActive() { this.abort.signal.throwIfAborted(); }
  closeStatus() { return this.status?.close(); }

  async complete() {
    this.assertActive();
    const result = await this.session!.complete();
    this.assertActive();
    clearTimeout(this.timer);
    // Coverage completion retires the job deadline, not startup signal ownership.
    return result;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.abort.abort(new Error('Daemon startup failed'));
      clearTimeout(this.timer);
      // Cancellation can race acquisition; await it before releasing its result.
      await this.opening?.catch(() => {});
      try {
        const results = await Promise.allSettled([this.session?.close(), this.closeStatus()]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally { this.dispose(); }
    })();
  }

  handoff() {
    this.assertActive();
    this.dispose();
  }

  private dispose() {
    clearTimeout(this.timer);
    this.session?.dispose();
    process.removeListener('SIGTERM', this.interrupt);
    process.removeListener('SIGINT', this.interrupt);
  }
}
