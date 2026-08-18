// Buyer-seat client for the v3 wire contract. Runs inside the buyer node
// (gateway backend) and standalone in harnesses/runbooks.
//
// Wallet custody: the depositing key comes from a gitignored env file
// (BUYER_WALLET_KEY=0x…) read at call time — never held on the instance,
// never logged. The client SIGNS requests; it never broadcasts transactions —
// deposits are made by the human (real-money gate) and only the tx hash
// enters here.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Wallet, getAddress } from "ethers";
import { canonicalize } from "../core/ledger.js";
import { buildAuthStatement } from "../seller/auth.js";
import { streamVerifier } from "../seller/streaming.js";
import { QUOTE_DOMAIN_V3 } from "../seller/front.js";
import { createPublicKey, verify as edVerify } from "node:crypto";

export interface VerifiedQuote {
  quote: Record<string, unknown>;
  quoteDigest: string;
  providerPublicPem: string;
  offerings: Array<Record<string, unknown>>;
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
  ok: boolean;
}

function readWalletKey(envFile: string): string {
  if (!existsSync(envFile)) throw new Error("E_WALLET_KEY_ABSENT");
  const line = readFileSync(envFile, "utf8").split("\n").map((l) => l.trim())
    .find((l) => l.startsWith("BUYER_WALLET_KEY="));
  const key = line?.slice("BUYER_WALLET_KEY=".length).trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("E_WALLET_KEY_ABSENT");
  return key;
}

export class BuyerClient {
  constructor(
    private readonly apiBase: string,          // seller front mount, e.g. http://host:9200/marketplace
    private readonly walletEnvFile: string,
    public tabId: string | null = null,
  ) {}

  address(): string {
    return getAddress(new Wallet(readWalletKey(this.walletEnvFile)).address);
  }

  /** GET /terms and verify the signed quote per-invariant. Unverifiable ≠ pass. */
  async fetchAndVerifyTerms(expect?: { providerAddress?: string; chainId?: number }): Promise<VerifiedQuote> {
    const res = await fetch(this.apiBase + "/terms", { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as TermsBody;
    return verifyTermsBody(res.status, body, expect);
  }

  /** POST /tab/open with the human-made deposit's tx hash. */
  async openTab(txHash: string, identityKaUal?: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const res = await fetch(this.apiBase + "/tab/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash, ...(identityKaUal ? { identityKaUal } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok && body.tab) this.tabId = String((body.tab as { tabId: string }).tabId);
    return { ok: res.ok, status: res.status, body };
  }

  /** EIP-191-signed POST under the open tab. */
  private async signedPost(path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.tabId) throw new Error("E_NO_TAB");
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const nonce = randomBytes(12).toString("hex");
    const statement = buildAuthStatement({ method: "POST", path, body, tabId: this.tabId, nonce });
    const wallet = new Wallet(readWalletKey(this.walletEnvFile));
    const signature = await wallet.signMessage(statement);
    const res = await fetch(this.apiBase + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nsm-tab": this.tabId,
        "x-nsm-address": wallet.address,
        "x-nsm-nonce": nonce,
        "x-nsm-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(180_000),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  chat(model: string, messages: Array<{ role: string; content: string }>, maxTokens = 256) {
    return this.signedPost("/v1/chat/completions", { model, messages, max_tokens: maxTokens });
  }

  /** v3.5 streaming chat: same signed request with stream:true; the response
   *  is SSE. Frames are fed to `onFrame` AND to an incremental chain verifier;
   *  the final signed leg's stream claims are checked against exactly what the
   *  wire carried. A broken chain is a withhold-grade verdict, not an error. */
  async chatStream(
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens = 256,
    onFrame?: (frame: Buffer, seq: number) => void,
  ): Promise<{
    status: number;
    body: Record<string, unknown>;
    stream?: { ok: boolean; detail?: string; frames: number; bytes: Buffer };
  }> {
    if (!this.tabId) throw new Error("E_NO_TAB");
    const payload = { model, messages, max_tokens: maxTokens, stream: true };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const nonce = randomBytes(12).toString("hex");
    const statement = buildAuthStatement({ method: "POST", path: "/v1/chat/completions", body, tabId: this.tabId, nonce });
    const wallet = new Wallet(readWalletKey(this.walletEnvFile));
    const signature = await wallet.signMessage(statement);
    const res = await fetch(this.apiBase + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nsm-tab": this.tabId,
        "x-nsm-address": wallet.address,
        "x-nsm-nonce": nonce,
        "x-nsm-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }
    const verifier = streamVerifier();
    let seq = 0;
    let final: Record<string, unknown> | null = null;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = event.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (!data || data === "[DONE]") continue;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
        if (typeof obj.frame === "string") {
          const frame = Buffer.from(obj.frame, "base64");
          verifier.push(frame);
          onFrame?.(frame, Number(obj.seq ?? seq));
          seq++;
        } else if (obj.final) {
          final = obj.final as Record<string, unknown>;
        }
      }
    }
    if (!final) return { status: 502, body: { error: "E_STREAM_NO_FINAL" } };
    const leg = (final.nsm as { leg?: Record<string, unknown> } | undefined)?.leg;
    const claims = leg?.streaming as { streamChainRoot?: string; frameCount?: number } | undefined;
    const bytesDigest = (leg?.evidence as { deliveredResponseBytesDigest?: string } | undefined)?.deliveredResponseBytesDigest;
    if (!claims?.streamChainRoot || !Number.isFinite(claims.frameCount) || !bytesDigest) {
      return { status: 200, body: final, stream: { ok: false, detail: "leg carries no stream claims", frames: seq, bytes: Buffer.alloc(0) } };
    }
    const v = verifier.finalize({
      streamChainRoot: claims.streamChainRoot, frameCount: Number(claims.frameCount),
      deliveredResponseBytesDigest: bytesDigest,
    });
    return {
      status: 200, body: final,
      stream: v.ok
        ? { ok: true, frames: seq, bytes: v.bytes }
        : { ok: false, detail: v.detail, frames: seq, bytes: Buffer.alloc(0) },
    };
  }
  query(sparql: string, offeringId?: string) {
    return this.signedPost("/v1/query", { sparql, ...(offeringId ? { offeringId } : {}) });
  }
  countersign(legId: string) {
    return this.signedPost(`/legs/${legId}/countersign`, {});
  }
  withhold(legId: string, code: string, detail?: string) {
    return this.signedPost(`/legs/${legId}/withhold`, { code, ...(detail ? { detail } : {}) });
  }
  close() {
    return this.signedPost("/close", {});
  }
}

// ── shared quote verification (v3.5): the SAME invariants whether the terms
// arrived over HTTP or over the SWM lane — transport must not change what
// "verified" means. Extracted from fetchAndVerifyTerms; the endpoint-
// discipline check is transport-aware: a quote must declare EITHER a direct
// apiBase or (lane-only) its laneContextGraphId — never neither.
export interface TermsBody {
  quote: Record<string, unknown>;
  quoteDigest: string;
  signature: string;
  providerPublicPem: string;
}

export function verifyTermsBody(
  status: number,
  body: TermsBody,
  expect?: { providerAddress?: string; chainId?: number },
): VerifiedQuote {
  const checks: VerifiedQuote["checks"] = [];
  const push = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, ...(detail ? { detail } : {}) });

  push("terms returns 402 (payment-required bootstrap)", status === 402, `status=${status}`);
  const digest = "sha256:" + createHash("sha256").update(canonicalize(body.quote)).digest("hex");
  push("quoteDigest == sha256(canonical quote)", digest === body.quoteDigest);
  let sigOk = false;
  try {
    sigOk = edVerify(null, Buffer.from(QUOTE_DOMAIN_V3 + "\n" + canonicalize(body.quote)),
      createPublicKey(body.providerPublicPem), Buffer.from(body.signature, "base64"));
  } catch { sigOk = false; }
  push("quote signature verifies under the delivered provider key", sigOk);
  const q = body.quote as {
    providerAddress?: string; chainId?: number; apiBase?: string | null;
    laneContextGraphId?: string | null; offerings?: Array<Record<string, unknown>>;
  };
  if (expect?.providerAddress) push("quote names the expected provider address", String(q.providerAddress).toLowerCase() === expect.providerAddress.toLowerCase(), String(q.providerAddress));
  if (expect?.chainId !== undefined) push("quote names the expected chain id", q.chainId === expect.chainId, String(q.chainId));
  const hasDirect = typeof q.apiBase === "string" && q.apiBase.length > 0;
  const hasLane = typeof q.laneContextGraphId === "string" && q.laneContextGraphId.length > 0;
  push("quote declares a reachable transport (apiBase and/or laneContextGraphId — endpoint discipline)", hasDirect || hasLane,
    `apiBase=${String(q.apiBase)} lane=${String(q.laneContextGraphId)}`);
  const offerings = q.offerings ?? [];
  push("quote lists at least one offering", offerings.length > 0);
  for (const o of offerings) {
    const id = String(o.id);
    push(`offering ${id}: provenanceClass declared`, o.provenanceClass === "weights-pinned" || o.provenanceClass === "upstream-claimed", String(o.provenanceClass));
    push(`offering ${id}: tokenizer bundle ref present`, typeof o.tokenizerBundleRef === "string" && (o.tokenizerBundleRef as string).length > 0);
    push(`offering ${id}: integer µTRAC pricing`, [o.perInputTokenMicroTrac, o.perOutputTokenMicroTrac, o.queryFlatMicroTrac, o.perReturnedQuadMicroTrac].every((n) => Number.isInteger(n) && (n as number) >= 0));
  }
  return {
    quote: body.quote, quoteDigest: body.quoteDigest, providerPublicPem: body.providerPublicPem,
    offerings, checks, ok: checks.every((c) => c.pass),
  };
}
