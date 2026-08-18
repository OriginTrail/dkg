// Buyer-side lane client — the BuyerClient surface over the SWM transport.
// Signs the IDENTICAL EIP-191 statements (method + path + body digest + tab +
// nonce); publishes the request via the buyer's OWN node; awaits the correlated
// response from the buyer's OWN node. No cross-device socket is ever opened.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Wallet, getAddress } from "ethers";
import { buildAuthStatement } from "../seller/auth.js";
import { newLaneId, nodeCaller, publishLaneMessage, pollLaneResponse } from "./swm-lane.js";

function readWalletKey(envFile: string): string {
  if (!existsSync(envFile)) throw new Error("E_WALLET_KEY_ABSENT");
  const line = readFileSync(envFile, "utf8").split("\n").map((l) => l.trim())
    .find((l) => l.startsWith("BUYER_WALLET_KEY="));
  const key = line?.slice("BUYER_WALLET_KEY=".length).trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("E_WALLET_KEY_ABSENT");
  return key;
}

export class LaneBuyerClient {
  private readonly call: ReturnType<typeof nodeCaller>;
  constructor(
    ownNodeBase: string,               // the buyer's OWN node, loopback
    ownNodeToken: string,
    private readonly contextGraphId: string,
    private readonly walletEnvFile: string,
    public tabId: string | null = null,
    private readonly responseTimeoutMs = 240_000,
    private readonly pollMs = 3_000,
    /** v3.5: provider this client buys FROM — stamped on every request so
     *  only that seller's executor answers (multi-seller CGs). */
    private readonly providerAddress: string | null = null,
  ) {
    this.call = nodeCaller(ownNodeBase, ownNodeToken);
  }

  address(): string {
    return getAddress(new Wallet(readWalletKey(this.walletEnvFile)).address);
  }

  private async roundTrip(method: string, path: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const id = newLaneId();
    await publishLaneMessage(this.call, this.contextGraphId, {
      kind: "request",
      req: { id, method, path, bodyB64: body.toString("base64"), headers, from: this.address(),
        ...(this.providerAddress ? { to: this.providerAddress } : {}), at: new Date().toISOString() },
    });
    const deadline = Date.now() + this.responseTimeoutMs;
    for (;;) {
      const res = await pollLaneResponse(this.call, this.contextGraphId, id);
      if (res) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.from(res.bodyB64, "base64").toString("utf8")) as Record<string, unknown>; } catch { /* raw */ }
        return { status: res.status, body: parsed };
      }
      if (Date.now() > deadline) return { status: 0, body: { error: "E_LANE_TIMEOUT", correlation: id } };
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** GET /terms over the lane (no auth — bootstrap). */
  async terms(): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.roundTrip("GET", "/terms", Buffer.alloc(0), {});
  }

  /** POST /tab/open over the lane (no tab auth yet — deposit-verified). */
  async openTab(txHash: string, identityKaUal?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const body = Buffer.from(JSON.stringify({ txHash, ...(identityKaUal ? { identityKaUal } : {}) }), "utf8");
    const out = await this.roundTrip("POST", "/tab/open", body, {});
    if (out.status === 200 && out.body.tab) this.tabId = String((out.body.tab as { tabId: string }).tabId);
    return out;
  }

  private async signedLane(path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.tabId) throw new Error("E_NO_TAB");
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const nonce = randomBytes(12).toString("hex");
    const statement = buildAuthStatement({ method: "POST", path, body, tabId: this.tabId, nonce });
    const wallet = new Wallet(readWalletKey(this.walletEnvFile));
    const signature = await wallet.signMessage(statement);
    return this.roundTrip("POST", path, body, {
      "x-nsm-tab": this.tabId,
      "x-nsm-address": wallet.address,
      "x-nsm-nonce": nonce,
      "x-nsm-signature": signature,
    });
  }

  chat(model: string, messages: Array<{ role: string; content: string }>, maxTokens = 256) {
    return this.signedLane("/v1/chat/completions", { model, messages, max_tokens: maxTokens });
  }
  query(sparql: string, offeringId?: string) {
    return this.signedLane("/v1/query", { sparql, ...(offeringId ? { offeringId } : {}) });
  }
  countersign(legId: string) {
    return this.signedLane(`/legs/${legId}/countersign`, {});
  }
  withhold(legId: string, code: string, detail?: string) {
    return this.signedLane(`/legs/${legId}/withhold`, { code, ...(detail ? { detail } : {}) });
  }
  close() {
    return this.signedLane("/close", {});
  }
}
