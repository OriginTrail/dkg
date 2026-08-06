// EIP-191 self-proving wallet binding — gates.
//
// Buyer-recommended (Hermes/Bo): "operator-vouched configuration alone should
// not be the final cryptographic identity proof." These gates attack the proof
// the way he would: replay it onto a different key, a different principal, a
// different chain; strip it; expire it; and check that presenting a bad proof
// can never quietly fall back to the weaker operator-vouched path.
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../../dist/daemon");
const { Wallet } = await import("ethers");
const B = await import(join(dist, "metering/evm-binding.js"));
const R = await import(join(dist, "metering/buyer-registry.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

const CHAIN = 8453;
const home = mkdtempSync(join(tmpdir(), "binding-"));
const pem = (k) => k.export({ type: "spki", format: "pem" }).toString();

const owner = Wallet.createRandom();                 // the EVM wallet that owns the principal
const stranger = Wallet.createRandom();
const ed = generateKeyPairSync("ed25519");
const edOther = generateKeyPairSync("ed25519");
const PRINCIPAL = owner.address;

const makeProof = async (over = {}) => {
  const base = {
    domain: B.BINDING_DOMAIN,
    principal: PRINCIPAL,
    walletPublicKeyPem: pem(ed.publicKey),
    chainId: CHAIN,
    notAfter: new Date(Date.now() + 3600e3).toISOString(),
    ...over,
  };
  const signer = over.__signer ?? owner;
  delete base.__signer;
  const evmSignature = await signer.signMessage(B.bindingStatement(base));
  return { ...base, evmSignature };
};

console.log("\nEIP-191 self-proving wallet binding\n");

console.log("the happy path, and what it actually proves:");
const good = await makeProof();
const v = B.verifyBinding(good, { chainId: CHAIN });
ok("a proof signed by the address owner verifies", v.ok, JSON.stringify(v));
ok("the verified principal is RECOVERED, not taken from the payload",
  v.ok && v.principal === PRINCIPAL);
ok("the fingerprint is over DER, so PEM whitespace cannot change it",
  B.ed25519Fingerprint(pem(ed.publicKey)) === B.ed25519Fingerprint(pem(ed.publicKey).replace(/\n/g, "\r\n")));

console.log("\nreplay and substitution:");
{
  // The original vulnerability wearing a hat: reuse a valid proof for a key
  // the owner never authorised.
  const swapped = { ...good, walletPublicKeyPem: pem(edOther.publicKey) };
  ok("a valid proof CANNOT be replayed onto a different ed25519 key",
    B.verifyBinding(swapped, { chainId: CHAIN }).code === "E_BINDING_SIGNER_MISMATCH");

  const reprincipaled = { ...good, principal: stranger.address };
  ok("a valid proof CANNOT be replayed onto a different principal",
    B.verifyBinding(reprincipaled, { chainId: CHAIN }).code === "E_BINDING_SIGNER_MISMATCH");

  const wrongChain = await makeProof({ chainId: 84532 });   // Base Sepolia
  ok("a testnet proof does not authorise mainnet",
    B.verifyBinding(wrongChain, { chainId: CHAIN }).code === "E_BINDING_WRONG_CHAIN");

  const byStranger = await makeProof({ __signer: stranger });
  ok("a stranger cannot sign a binding naming someone else's principal",
    B.verifyBinding(byStranger, { chainId: CHAIN }).code === "E_BINDING_SIGNER_MISMATCH");

  const expired = await makeProof({ notAfter: new Date(Date.now() - 1000).toISOString() });
  ok("an expired proof is refused", B.verifyBinding(expired, { chainId: CHAIN }).code === "E_BINDING_EXPIRED");

  const wrongDomain = await makeProof({ domain: "some-other-protocol:v1" });
  ok("a proof from another domain is refused",
    B.verifyBinding(wrongDomain, { chainId: CHAIN }).code === "E_BINDING_WRONG_DOMAIN");

  ok("a garbage signature is refused, not thrown",
    B.verifyBinding({ ...good, evmSignature: "0xdeadbeef" }, { chainId: CHAIN }).code === "E_BINDING_BAD_SIGNATURE");
  ok("a malformed proof is refused, not thrown",
    B.verifyBinding({ domain: B.BINDING_DOMAIN }, { chainId: CHAIN }).code === "E_BINDING_MALFORMED");
}

console.log("\nno silent downgrade to the weaker path:");
{
  // Registry says the OTHER key is authorised for this principal.
  mkdirSync(join(home, "metering"), { recursive: true });
  writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({
    principals: { [PRINCIPAL.toLowerCase()]: { label: "operator-vouched", walletPublicKeyPem: pem(edOther.publicKey) } },
  }));

  const noProof = R.anchorWalletKey(home, PRINCIPAL, { chainId: CHAIN });
  ok("with no proof presented, the operator-vouched registry still works",
    noProof.ok && noProof.walletPublicKeyPem === pem(edOther.publicKey));

  const withProof = R.anchorWalletKey(home, PRINCIPAL, { proof: good, chainId: CHAIN });
  ok("a valid proof TAKES PRECEDENCE over the registry entry",
    withProof.ok && withProof.walletPublicKeyPem === pem(ed.publicKey) && withProof.label.startsWith("self-proved:"),
    JSON.stringify(withProof));

  // The attack this guards: strip/blunt a proof you cannot forge and hope the
  // provider falls back to a path you CAN influence.
  const badProof = R.anchorWalletKey(home, PRINCIPAL, { proof: { ...good, evmSignature: "0xdead" }, chainId: CHAIN });
  ok("an INVALID proof is a hard failure — never a fallback to the registry",
    badProof.ok === false, JSON.stringify(badProof));

  const mismatched = R.anchorWalletKey(home, stranger.address, { proof: good, chainId: CHAIN });
  ok("a proof for principal A cannot anchor a delegation claiming principal B",
    mismatched.ok === false);
}

console.log("\naddress casing:");
{
  const lower = R.anchorWalletKey(home, PRINCIPAL.toLowerCase(), { proof: good, chainId: CHAIN });
  ok("a lowercase principal still matches its checksummed proof",
    lower.ok === true, JSON.stringify(lower));
}

console.log(`\n${pass}/${pass + fail} binding gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
