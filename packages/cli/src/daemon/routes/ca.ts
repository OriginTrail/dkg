// Conviction Account service spending routes, /api/ca (OT-RFC-27). They sit
// beside /api/pca and follow its rules:
//
// - Writes need a node-admin token; reads any valid token.
// - The owner's writes are signed by the primary operational wallet
//   (opWallets.wallets[0]), as every server-side PCA write is. Consent and
//   funding are signed by the buyer key (chain.caBuyerAddress, else the
//   primary wallet), a local wallet or an external signer's payer account.
// - Every route answers 503 when the chain has no service contracts, or when
//   it needs the buyer key and the node holds no signer for it.
// - A contract's refusal is answered by its kind: 400 invalid, 403 forbidden,
//   404 unknown account, 409 conflict, 503 unavailable, with the revert's
//   name as `error` and its arguments as `args`.
// - Amounts are decimal strings of wei with `…Trac` siblings (ca-wire.ts).
//   Status reads are fresh; every write invalidates the account's cached
//   Publishing Conviction read.

import type { ServerResponse } from 'node:http';
import {
  CA_LABELS_MAX_EPOCHS,
  SERVICE_ASSIGNMENT_TYPES,
  assignmentCapsRefusal,
  isConvictionServiceError,
  isConvictionServiceRevertError,
  isPcaUnavailableError,
  isRemoteSignerError,
  serviceAssignmentDigest,
  type CaAssignmentTerms,
  type CaEip712Domain,
  type ConvictionServiceErrorKind,
  type TxResult,
} from '@origintrail-official/dkg-chain';
import {
  isPayloadTooLargeError,
  jsonResponse,
  readBody,
  respondIfChainRpcTransportError,
  respondWithDaemonError,
  safeDecodeURIComponent,
  sanitizeRpcMessage,
  SMALL_BODY_BYTES,
} from '../http-utils.js';
import { canAdministerNode } from '../../auth.js';
import type { RequestContext } from './context.js';
import {
  CaBadRequest,
  assignmentWire,
  capsOf,
  capsWire,
  labelWire,
  parseAddress,
  parseCapsInput,
  parseConsentInput,
  parseFundingInput,
  parseInteger,
  parseSignature,
  parseTermsWire,
  periodWire,
  requireObject,
  revertArgsWire,
  sameCaps,
  statusWire,
  termsWire,
  usageWire,
} from './ca-wire.js';

const CA_PREFIX = '/api/ca';
const UINT32_MAX = 0xffff_ffff;

const FEATURE_UNAVAILABLE_503 = {
  error: 'Conviction Account service spending is not available on this node: the chain adapter has no '
    + 'service-spending surface, or the Hub has no ServiceSubscriptions and ConvictionServiceStorage',
  code: 'CA_UNAVAILABLE',
};
const BUYER_KEY_UNAVAILABLE_503 = {
  error: 'This node holds no signer for its Conviction Account buyer key: chain.caBuyerAddress must be one of '
    + 'its operational wallets, a local key or a payer account of the external signer',
  code: 'CA_BUYER_KEY_UNAVAILABLE',
};
const STATUS_OF_KIND: Readonly<Record<ConvictionServiceErrorKind, number>> = {
  invalid: 400, forbidden: 403, 'not-found': 404, conflict: 409, unavailable: 503, internal: 500,
};
// An external signer that is unreachable or slow is unavailable; any other
// refusal or failure of it is a bad answer from an upstream service.
const SIGNER_STATUS: Readonly<Record<string, number>> = { REMOTE_SIGNER_UNAVAILABLE: 503, REMOTE_SIGNER_TIMEOUT: 504 };
const CONSENT_SIGNER_HINT = 'The buyer key\'s signer refused the ServiceAssignment typed data. Allow that EIP-712 '
  + 'domain for this payer account, or consent by sending the assignment from this node instead: '
  + 'POST /api/ca/:id/assignments with the terms and the owner\'s signature.';

/** A route's answer when the facade or the chain cannot serve it. */
class CaRefusal extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

const unavailable = (): CaRefusal => new CaRefusal(503, FEATURE_UNAVAILABLE_503);
const revertRefusal = (status: number, name: string, accountId: string, args: Record<string, unknown> = {}): CaRefusal =>
  new CaRefusal(status, { error: name, accountId, args });

/** The value, or a 503 when the facade answered `null` (the adapter lacks the method). */
function present<T>(value: T | null): T {
  if (value === null) throw unavailable();
  return value;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The first remote-signer failure in an error's cause chain. */
function remoteSignerFailureOf(err: unknown): { code: string; message: string } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
    if (isRemoteSignerError(current)) {
      return { code: current.code, message: (current as { message?: unknown }).message as string ?? current.code };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function respondCaError(res: ServerResponse, err: unknown, op: string, accountId?: string, signerHint?: string): void {
  const where = accountId === undefined ? {} : { accountId };
  if (err instanceof CaRefusal) return jsonResponse(res, err.status, err.body);
  if (err instanceof CaBadRequest) return jsonResponse(res, 400, { error: err.message, ...where, ...err.extra });
  if (isPayloadTooLargeError(err)) return respondWithDaemonError(res, err);
  const msg = err instanceof Error ? err.message : String(err);
  if (/No blockchain configured/i.test(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
  if (isConvictionServiceRevertError(err)) {
    return jsonResponse(res, STATUS_OF_KIND[err.kind] ?? 500, { error: err.revertName, ...where, args: revertArgsWire(err.args) });
  }
  if (isConvictionServiceError(err)) {
    return jsonResponse(res, STATUS_OF_KIND[err.kind] ?? 500, { error: sanitizeRpcMessage(err.message), code: err.code, ...where });
  }
  if (isPcaUnavailableError(err) || /not deployed on this Hub/i.test(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
  if (respondIfChainRpcTransportError(res, err)) return;
  const signer = remoteSignerFailureOf(err);
  if (signer) {
    const refused = signer.code === 'REMOTE_SIGNER_REJECTED' || signer.code === 'REMOTE_SIGNER_METHOD_NOT_SUPPORTED';
    return jsonResponse(res, SIGNER_STATUS[signer.code] ?? 502, {
      error: sanitizeRpcMessage(signer.message), code: signer.code, ...where,
      ...(refused && signerHint ? { hint: signerHint } : {}),
    });
  }
  return jsonResponse(res, 500, { error: `${op} failed: ${sanitizeRpcMessage(msg)}`, ...where });
}

async function readJsonObject(ctx: RequestContext): Promise<Record<string, unknown>> {
  const body = await readBody(ctx.req, SMALL_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new CaBadRequest(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return requireObject(parsed, 'The request body');
}

function parseAccountId(idStr: string): bigint {
  if (!/^\d+$/.test(idStr)) throw new CaBadRequest('Invalid accountId: it must be a non-negative integer');
  return BigInt(idStr);
}

function queryInteger(ctx: RequestContext, name: string): number | undefined {
  const raw = ctx.url.searchParams.get(name);
  return raw === null ? undefined : parseInteger(raw, name, 0, Number.MAX_SAFE_INTEGER);
}

function txWire(tx: TxResult): { txHash: string; blockNumber: number } {
  // A receipt that reverted is never a write that happened.
  if (tx.success === false) {
    throw new CaRefusal(502, { error: 'The transaction was mined but did not succeed on-chain', txHash: tx.hash });
  }
  return { txHash: tx.hash, blockNumber: tx.blockNumber };
}

function sameDomain(raw: unknown, domain: CaEip712Domain): boolean {
  const d = raw as Partial<Record<keyof CaEip712Domain, unknown>> | null;
  return typeof d === 'object' && d !== null && d.name === domain.name && String(d.version) === domain.version
    && Number(d.chainId) === domain.chainId && typeof d.verifyingContract === 'string'
    && same(d.verifyingContract, domain.verifyingContract);
}

interface CaCall {
  ctx: RequestContext;
  accountId: bigint;
  idStr: string;
  primary: string | null;
}

/** The account's owner, from the Publishing Conviction read the /api/pca routes use; 404 for an unknown account. */
async function ownerOf(call: CaCall): Promise<string> {
  const info = await call.ctx.agent.getPublishingConvictionAccountInfo(call.accountId);
  if (info !== null) return info.owner;
  if (!call.ctx.agent.supportsPublishingConvictionNft) throw unavailable();
  throw revertRefusal(404, 'UnknownAccount', call.idStr);
}

async function getStatus({ ctx, accountId, idStr, primary }: CaCall): Promise<void> {
  const status = await ctx.agent.getConvictionServiceStatus(accountId);
  if (status === null) {
    if (!ctx.agent.supportsConvictionService) throw unavailable();
    throw revertRefusal(404, 'UnknownAccount', idStr);
  }
  jsonResponse(ctx.res, 200, statusWire(status, {
    ownedByNode: primary !== null && same(status.owner, primary),
    buyerKey: ctx.agent.getConvictionServiceBuyerAddress(),
  }));
}

async function postServices({ ctx, accountId, idStr }: CaCall): Promise<void> {
  const body = await readJsonObject(ctx);
  if (typeof body.enabled !== 'boolean' || Object.keys(body).length !== 1) {
    throw new CaBadRequest('The body must be { "enabled": true } or { "enabled": false }');
  }
  const tx = present(await ctx.agent.setConvictionServiceSpending(accountId, body.enabled));
  jsonResponse(ctx.res, 200, { accountId: idStr, enabled: body.enabled, ...txWire(tx) });
}

async function postConsent({ ctx, accountId, idStr }: CaCall): Promise<void> {
  if (!ctx.agent.supportsConvictionService) throw unavailable();
  const buyerKey = ctx.agent.getConvictionServiceBuyerAddress();
  if (buyerKey === null) throw new CaRefusal(503, BUYER_KEY_UNAVAILABLE_503);
  const { caps, nonce } = parseConsentInput(await readJsonObject(ctx));
  // The contracts check the same rules when the terms are submitted; the
  // chain's own longest period is checked then.
  const reason = assignmentCapsRefusal(caps, UINT32_MAX, Math.floor(Date.now() / 1000));
  if (reason !== null) throw revertRefusal(400, 'InvalidAssignmentTerms', idStr, { reason });
  const { domain } = present(await ctx.agent.getConvictionServiceContracts());
  const terms: CaAssignmentTerms = {
    accountId,
    assignee: buyerKey,
    ...caps,
    nonce: nonce === 'auto' ? present(await ctx.agent.getConvictionServiceAssignmentNonce(accountId)) : nonce,
  };
  const consent = present(await ctx.agent.signConvictionServiceConsent(terms));
  jsonResponse(ctx.res, 200, { terms: termsWire(terms), digest: consent.digest, assigneeSignature: consent.signature, domain });
}

async function postAssignment(call: CaCall): Promise<void> {
  const { ctx, accountId, idStr, primary } = call;
  if (!ctx.agent.supportsConvictionService) throw unavailable();
  const body = await readJsonObject(ctx);
  const unknown = Object.keys(body).filter((k) => !['terms', 'assigneeSignature', 'ownerSignature', 'digest', 'domain'].includes(k));
  if (unknown.length > 0) throw new CaBadRequest(`The request body has unknown field(s): ${unknown.join(', ')}`);
  const terms = parseTermsWire(body.terms, accountId);
  const assigneeSignature = parseSignature(body.assigneeSignature, 'assigneeSignature');
  const ownerSignature = parseSignature(body.ownerSignature, 'ownerSignature');
  // A consent answer carries the domain and digest it was signed under: one
  // signed for another chain or contract is refused before anything is sent.
  if (body.domain !== undefined || body.digest !== undefined) {
    const { domain } = present(await ctx.agent.getConvictionServiceContracts());
    if (body.domain !== undefined && !sameDomain(body.domain, domain)) {
      throw new CaBadRequest('The terms were signed under another EIP-712 domain than this chain\'s ServiceSubscriptions', { domain });
    }
    if (body.digest !== undefined && (typeof body.digest !== 'string' || !same(body.digest, serviceAssignmentDigest(domain, terms)))) {
      throw new CaBadRequest('digest is not the digest of these terms under this chain\'s ServiceSubscriptions domain');
    }
  }
  const owner = await ownerOf(call);
  const buyerKey = ctx.agent.getConvictionServiceBuyerAddress();
  let sendAs: 'owner' | 'assignee';
  if (primary !== null && same(owner, primary)) {
    sendAs = 'owner';
    if (assigneeSignature === undefined && !same(terms.assignee, primary)) {
      throw new CaBadRequest('assigneeSignature is required: this node owns the account and submits the assignment with the assignee\'s consent');
    }
  } else if (buyerKey !== null && same(terms.assignee, buyerKey)) {
    sendAs = 'assignee';
    if (ownerSignature === undefined) {
      throw new CaBadRequest('ownerSignature is required: this node is the assignee and submits the assignment with the owner\'s consent');
    }
  } else {
    throw new CaRefusal(403, {
      error: 'This node is neither the owner of the account nor its assignee', accountId: idStr,
      owner, nodeWallet: primary, buyerKey, assignee: terms.assignee,
    });
  }
  const tx = present(await ctx.agent.assignConvictionServiceBuyer(terms, { owner: ownerSignature, assignee: assigneeSignature }, sendAs));
  jsonResponse(ctx.res, 200, { accountId: idStr, assignee: terms.assignee, digest: tx.digest, sentAs: sendAs, ...txWire(tx) });
}

async function getAssignments(call: CaCall): Promise<void> {
  await ownerOf(call);
  const assignments = present(await call.ctx.agent.listConvictionServiceAssignments(call.accountId));
  jsonResponse(call.ctx.res, 200, { accountId: call.idStr, assignments: assignments.map(assignmentWire) });
}

async function deleteAssignment({ ctx, accountId, idStr }: CaCall, assignee: string): Promise<void> {
  const tx = present(await ctx.agent.revokeConvictionServiceBuyer(accountId, assignee));
  jsonResponse(ctx.res, 200, { accountId: idStr, assignee, revoked: true, nextNonce: tx.nextNonce.toString(), ...txWire(tx) });
}

/**
 * Change a live assignment's caps on the owner node: the body's fields over
 * the stored caps, read fresh. Equal caps send nothing (`unchanged: true`), so
 * a retried request never meets `CapsUnchanged`. Checked in the contract's
 * order: the owner, a live assignment, the caps.
 */
async function postCaps(call: CaCall, assignee: string): Promise<void> {
  const { ctx, accountId, idStr, primary } = call;
  if (!ctx.agent.supportsConvictionService) throw unavailable();
  const input = parseCapsInput(await readJsonObject(ctx));
  const owner = await ownerOf(call);
  if (primary === null || !same(owner, primary)) {
    throw revertRefusal(403, 'NotAccountOwner', idStr, { accountId: idStr, caller: primary, owner });
  }
  const stored = present(await ctx.agent.listConvictionServiceAssignments(accountId)).find((a) => same(a.assignee, assignee));
  if (!stored) throw revertRefusal(403, 'NotAssigned', idStr, { accountId: idStr, assignee });
  if (stored.revokedAt !== 0) throw revertRefusal(409, 'AssignmentRevoked', idStr, { accountId: idStr, assignee: stored.assignee });
  if (!stored.active) throw revertRefusal(409, 'AssignmentExpired', idStr, { accountId: idStr, assignee: stored.assignee });
  const current = capsOf(stored);
  const caps = { ...current, ...input };
  const answer = { accountId: idStr, assignee: stored.assignee, caps: capsWire(caps), usage: usageWire(stored.usage) };
  if (sameCaps(caps, current)) return jsonResponse(ctx.res, 200, { ...answer, unchanged: true });
  const reason = assignmentCapsRefusal(caps, UINT32_MAX, Math.floor(Date.now() / 1000));
  if (reason !== null) throw revertRefusal(400, 'InvalidAssignmentTerms', idStr, { reason });
  const tx = present(await ctx.agent.updateConvictionServiceCaps(accountId, stored.assignee, caps));
  jsonResponse(ctx.res, 200, { ...answer, unchanged: false, ...txWire(tx) });
}

async function postNonce({ ctx, accountId, idStr }: CaCall): Promise<void> {
  const tx = present(await ctx.agent.advanceConvictionServiceNonce(accountId));
  jsonResponse(ctx.res, 200, { accountId: idStr, nextNonce: tx.nextNonce.toString(), ...txWire(tx) });
}

/** Labels per epoch, `from` to `to` inclusive: by default the first epochs of the account's span. */
async function getLabels({ ctx, accountId, idStr }: CaCall): Promise<void> {
  const fromParam = queryInteger(ctx, 'from');
  const toParam = queryInteger(ctx, 'to');
  const status = await ctx.agent.getConvictionServiceStatus(accountId);
  if (status === null) {
    if (!ctx.agent.supportsConvictionService) throw unavailable();
    throw revertRefusal(404, 'UnknownAccount', idStr);
  }
  const from = fromParam ?? status.schedule.firstEpoch;
  const to = toParam ?? Math.max(from, Math.min(from + CA_LABELS_MAX_EPOCHS - 1, status.schedule.lastEpoch));
  if (to < from || to - from + 1 > CA_LABELS_MAX_EPOCHS) {
    throw new CaBadRequest(`from and to must cover 1 to ${CA_LABELS_MAX_EPOCHS} epochs, from <= to`);
  }
  const epochs = present(await ctx.agent.getConvictionServiceLabels(accountId, from, to));
  jsonResponse(ctx.res, 200, { accountId: idStr, cursor: status.labels.cursor, from, to, epochs: epochs.map(labelWire) });
}

async function getPeriods(call: CaCall): Promise<void> {
  const offset = queryInteger(call.ctx, 'offset') ?? 0;
  const limit = queryInteger(call.ctx, 'limit') ?? 50;
  await ownerOf(call);
  const page = present(await call.ctx.agent.listServicePeriods(call.accountId, offset, limit));
  jsonResponse(call.ctx.res, 200, { accountId: call.idStr, total: page.total, offset, limit, periods: page.periods.map(periodWire) });
}

/** Fund one plan period with the buyer key; a repeated `periodId` answers the stored period with `existing: true`. */
async function postPeriod({ ctx, accountId }: CaCall): Promise<void> {
  if (!ctx.agent.supportsConvictionService) throw unavailable();
  if (ctx.agent.getConvictionServiceBuyerAddress() === null) throw new CaRefusal(503, BUYER_KEY_UNAVAILABLE_503);
  const request = parseFundingInput(await readJsonObject(ctx), accountId);
  const funding = present(await ctx.agent.fundServicePeriodFromConviction(request));
  jsonResponse(ctx.res, 200, {
    ...periodWire(funding.period), txHash: funding.hash, blockNumber: funding.blockNumber,
    logIndex: funding.logIndex, existing: funding.existing,
  });
}

async function getContracts(ctx: RequestContext): Promise<void> {
  const contracts = present(await ctx.agent.getConvictionServiceContracts());
  jsonResponse(ctx.res, 200, { ...contracts, primaryType: 'ServiceAssignment', types: SERVICE_ASSIGNMENT_TYPES });
}

/** The accounts this node owns (its primary wallet, ERC721Enumerable) and those its buyer key is assigned on. */
async function getMine(ctx: RequestContext, primary: string | null): Promise<void> {
  if (!ctx.agent.supportsConvictionService) throw unavailable();
  const buyerKey = ctx.agent.getConvictionServiceBuyerAddress();
  const owned = primary === null ? [] : present(await ctx.agent.listPublishingConvictionAccountsForWallets([primary]));
  const assigned = buyerKey === null ? [] : present(await ctx.agent.listConvictionServiceAccountsByAssignee(buyerKey));
  jsonResponse(ctx.res, 200, {
    owner: primary,
    buyerKey,
    owned: owned.filter((a) => a.relation !== 'agent').map((a) => ({ accountId: a.accountId.toString() })),
    assigned: assigned.map((a) => ({ accountId: a.accountId.toString(), ...assignmentWire(a) })),
  });
}

export async function handleCaRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (path !== CA_PREFIX && !path.startsWith(`${CA_PREFIX}/`)) return;
  const segments = path.slice(CA_PREFIX.length + 1).split('/');
  const method = req.method ?? 'GET';
  const primary = ctx.opWallets.wallets[0]?.address ?? null;

  if (method === 'GET' && segments.length === 1 && (segments[0] === 'contracts' || segments[0] === 'mine')) {
    try {
      return await (segments[0] === 'contracts' ? getContracts(ctx) : getMine(ctx, primary));
    } catch (err) {
      return respondCaError(res, err, segments[0] === 'contracts' ? 'getConvictionServiceContracts' : 'listing this node\'s accounts');
    }
  }

  type Route = { write: boolean; op: string; run: (call: CaCall, assignee: string) => Promise<void>; consent?: boolean };
  const [idPart, resource, assigneePart, tail] = segments;
  const routes: Record<string, Route | undefined> = {
    'GET 1': { write: false, op: 'getConvictionServiceStatus', run: getStatus },
    'POST 2 services': { write: true, op: 'setConvictionServiceSpending', run: postServices },
    'POST 2 consent': { write: true, op: 'signConvictionServiceConsent', run: postConsent, consent: true },
    'POST 2 assignments': { write: true, op: 'assignConvictionServiceBuyer', run: postAssignment },
    'GET 2 assignments': { write: false, op: 'listConvictionServiceAssignments', run: getAssignments },
    'DELETE 3 assignments': { write: true, op: 'revokeConvictionServiceBuyer', run: deleteAssignment },
    'POST 4 assignments caps': { write: true, op: 'updateConvictionServiceCaps', run: postCaps },
    'POST 2 nonce': { write: true, op: 'advanceConvictionServiceNonce', run: postNonce },
    'GET 2 labels': { write: false, op: 'getConvictionServiceLabels', run: getLabels },
    'GET 2 periods': { write: false, op: 'listServicePeriods', run: getPeriods },
    'POST 2 periods': { write: true, op: 'fundServicePeriodFromConviction', run: postPeriod },
  };
  const key = [method, segments.length, resource, segments.length === 4 ? tail : undefined].filter((p) => p !== undefined).join(' ');
  const route = routes[key];
  if (!route || idPart === '' || (segments.length === 3 && assigneePart === '')) return;

  if (route.write && !canAdministerNode(ctx.authentication)) {
    return jsonResponse(res, 403, {
      error: 'Node-admin token required (~/.dkg/auth.token) to manage Conviction Account service spending; '
        + 'agent-scoped tokens cannot drive the node\'s signed Conviction Account writes.',
    });
  }
  const idStr = safeDecodeURIComponent(idPart!, res);
  if (idStr === null) return;
  let assignee = '';
  if (segments.length >= 3) {
    const decoded = safeDecodeURIComponent(assigneePart!, res);
    if (decoded === null) return;
    assignee = decoded;
  }
  try {
    const accountId = parseAccountId(idStr);
    if (segments.length >= 3) assignee = parseAddress(assignee, 'assignee');
    await route.run({ ctx, accountId, idStr, primary }, assignee);
  } catch (err) {
    respondCaError(res, err, route.op, idStr, route.consent ? CONSENT_SIGNER_HINT : undefined);
  }
}
