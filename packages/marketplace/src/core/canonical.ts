// Canonicalization + provider signing — extracted from the retired tab
// ledger (P5 tab-rail deletion). NOT refund-shaped: these are the crypto
// utilities every signed artifact uses (statements, checkpoints, attestations,
// dispute recounts). The D12 v1.1 rules carry over verbatim.

import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    // D12 v1.1 (buyer-found, Hermes/Bo 2026-08-06): NO floats in signed
    // material — integer tenths or bust; a trailing ".0" does not survive
    // JSON serialization, so two conforming seats could diverge.
    if (!Number.isInteger(value)) throw new Error(`E_CANON_NON_INTEGER: ${value} (use integer tenths for U)`);
    if (!Number.isSafeInteger(value)) throw new Error("E_CANON_UNSAFE_INTEGER");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    // Only PLAIN objects: a Date/Map/Set would silently serialize as `{}` —
    // data loss inside signed material. Reject rather than coerce.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`E_CANON_NON_PLAIN_OBJECT: ${value?.constructor?.name ?? "unknown"} (serialize it explicitly first)`);
    }
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
  }
  throw new Error(`unsupported type ${typeof value}`);
}

function meterDir(home: string): string {
  const d = join(home, "metering");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function providerKeys(home: string): { publicPem: string; privatePem: string } {
  const f = join(meterDir(home), "provider-keys.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  writeFileSync(f, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export const providerKeyId = (home: string): string =>
  "ed25519:" + sha256(providerKeys(home).publicPem).slice(0, 16);

export function providerPublicPem(home: string): string {
  return providerKeys(home).publicPem;
}

/** Sign `material` under a domain with the node's provider key. */
export function providerSign(home: string, domain: string, material: string): string {
  const preimage = Buffer.concat([Buffer.from(domain + "\n"), Buffer.from(material)]);
  return edSign(null, preimage, createPrivateKey(providerKeys(home).privatePem)).toString("base64");
}
