// Chain-confirmed Knowledge Collection metadata read routes.
//
//   GET /api/kc/:id          — latest merkleRoot (hex) + author tuple
//   GET /api/kc/:id/author   — chain-confirmed author (attested flag)
//
// These are read-only on-chain lookups (NOT part of the WM/SWM/VM lifecycle
// surface), extracted verbatim out of the retired routes/assertion.ts so the
// assertion→knowledge-assets migration could delete that file. The `/api/kc`
// prefix and exact response shapes are preserved unchanged.
import type { RequestContext } from "./context.js";
import { jsonResponse } from "../http-utils.js";

export async function handleKcChainMetadataRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path } = ctx;
  if (!path.startsWith("/api/kc/")) return;

  // GET /api/kc/:id — chain-confirmed metadata for a knowledge collection.
  // Returns latest merkleRoot (hex) and the author tuple. Useful for LU-8
  // verification: members fetch the merkleRoot off-chain and feed it to
  // verify-batch as `expectedMerkleRoot`.
  if (req.method === "GET" && /^\/api\/kc\/[^/]+$/.test(path)) {
    const idStr = decodeURIComponent(path.split("/")[3] ?? "");
    if (!/^\d+$/.test(idStr)) {
      return jsonResponse(res, 400, {
        error: "Invalid kaId — must be a non-negative integer",
      });
    }
    const kaId = BigInt(idStr);
    try {
      const chain: any = (agent as any).chain ?? (agent as any).chainAdapter;
      if (!chain?.getLatestMerkleRoot) {
        return jsonResponse(res, 503, {
          error: "Chain adapter does not expose getLatestMerkleRoot",
        });
      }
      const rootBytes: Uint8Array = await chain.getLatestMerkleRoot(kaId);
      const rootHex = "0x" + Array.from(rootBytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");
      let author: string | null = null;
      try {
        if (typeof agent.getKnowledgeCollectionAuthor === "function") {
          const a = await agent.getKnowledgeCollectionAuthor(kaId);
          if (a && a !== "0x0000000000000000000000000000000000000000") author = a;
        }
      } catch { /* attestation lookup is optional */ }
      return jsonResponse(res, 200, {
        kaId: idStr,
        merkleRoot: rootHex,
        author,
      });
    } catch (err: any) {
      // Mirror the unknown-kaId mapping the sibling `/api/kc/:id/author` route
      // does so callers can branch on "not published yet" (404) vs. server
      // failure (500). KCS reverts on lookups for ids that don't exist.
      const msg = err?.message ?? String(err);
      if (/unknown kaId|nonexistent|out-of-bounds/i.test(msg)) {
        return jsonResponse(res, 404, { error: `Unknown kaId ${idStr}` });
      }
      return jsonResponse(res, 500, { error: msg });
    }
  }

  // GET /api/kc/:id/author — chain-confirmed author for a knowledge
  // collection's latest merkle-root entry. Delegates to
  // `agent.getKnowledgeCollectionAuthor`, which reads
  // `KnowledgeCollectionStorage.getLatestMerkleRootAuthor(kaId)`. Returns the
  // EIP-712-recovered / EIP-1271-verified author for V10.1+ publishes, or the
  // zero address for un-attested writes (surfaced as `attested: false`).
  // Adapters without the view return 503 ("requires V10.1 chain adapter").
  if (req.method === "GET" && /^\/api\/kc\/[^/]+\/author$/.test(path)) {
    const idStr = decodeURIComponent(path.split("/")[3] ?? "");
    if (!/^\d+$/.test(idStr)) {
      return jsonResponse(res, 400, {
        error: "Invalid kaId — must be a non-negative integer",
      });
    }
    const kaId = BigInt(idStr);
    try {
      const author = await agent.getKnowledgeCollectionAuthor(kaId);
      if (author === null) {
        return jsonResponse(res, 503, {
          error:
            "Chain adapter does not expose getLatestMerkleRootAuthor — " +
            "V10.1 author attestation is not available on this deployment",
        });
      }
      const ZERO = "0x0000000000000000000000000000000000000000";
      const attested = author.toLowerCase() !== ZERO;
      return jsonResponse(res, 200, {
        kaId: idStr,
        author: attested ? author : null,
        attested,
      });
    } catch (err: any) {
      // KCS reverts on unknown kaId; map to 404 so callers can branch on
      // "not published yet" vs "no attestation."
      const msg = err?.message ?? String(err);
      if (/unknown kaId|nonexistent|out-of-bounds/i.test(msg)) {
        return jsonResponse(res, 404, { error: `Unknown kaId ${idStr}` });
      }
      throw err;
    }
  }
}
