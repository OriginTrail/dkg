// SPDX-License-Identifier: Apache-2.0

/**
 * Sending an agent's profile again when its broadcast reached no peer.
 *
 * A node broadcasts its profile over gossip, every 20 minutes and when it
 * changes. A broadcast to a topic without subscribers succeeds silently, and a
 * peer drops gossip from a node it has not admitted yet, which is the usual
 * state of the peers an Edge has just connected to. Such a profile would wait
 * for the next heartbeat. So the broadcast's recipients are counted, as peers
 * this node has itself admitted, the closest a sender can come to "this peer
 * acts on my gossip" without an acknowledgement in the protocol. While there is
 * none the same profile goes out again, with growing pauses. A newer profile
 * takes over from one still being sent. The pauses end well before the next
 * heartbeat, which starts over.
 */

/** Pauses before each further send of a profile that reached no admitted peer. */
export const AGENT_PROFILE_RESEND_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000];

export interface AgentProfileResendPorts {
  isRunning(): boolean;
  isAdmitted(peerId: string): boolean;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

/** The peers a broadcast went to; undefined when the pubsub implementation does not say. */
type Recipients = readonly string[] | undefined;

export class AgentProfileResends {
  readonly #ports: AgentProfileResendPorts;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ports: AgentProfileResendPorts) {
    this.#ports = ports;
  }

  /** A profile has just been broadcast to `recipients`. Takes over from a profile still being sent. */
  track(recipients: Recipients, resend: () => Promise<Recipients>): void {
    this.#generation += 1;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#continue(recipients, resend, 0, this.#generation);
  }

  #continue(recipients: Recipients, resend: () => Promise<Recipients>, sent: number, generation: number): void {
    if (recipients === undefined || recipients.some((peerId) => this.#ports.isAdmitted(peerId))) {
      if (sent > 0) this.#ports.logInfo(`Agent profile reached an admitted peer after ${sent} more send(s)`);
      return;
    }
    const delay = AGENT_PROFILE_RESEND_DELAYS_MS[sent];
    if (delay === undefined) {
      this.#ports.logWarn(`Agent profile reached no admitted peer in ${sent + 1} sends; the next heartbeat publishes it again`);
      return;
    }
    this.#ports.logInfo(`Agent profile reached no admitted peer (${recipients.length} recipients); sending it again in ${delay} ms`);
    const timer = setTimeout(() => {
      if (!this.#ports.isRunning()) return;
      void resend()
        .catch((): Recipients => [])
        .then((again) => {
          if (generation === this.#generation) this.#continue(again, resend, sent + 1, generation);
        });
    }, delay);
    timer.unref?.();
    this.#timer = timer;
  }
}

const resendsByHost = new WeakMap<object, AgentProfileResends>();

/** One per agent-like host, created on first use, as the other per-agent runtimes here. */
export function agentProfileResendsFor(host: object, create: () => AgentProfileResends): AgentProfileResends {
  let resends = resendsByHost.get(host);
  if (resends === undefined) {
    resends = create();
    resendsByHost.set(host, resends);
  }
  return resends;
}
