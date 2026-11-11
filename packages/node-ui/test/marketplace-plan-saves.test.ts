// @vitest-environment happy-dom
// Plan saves in confirmation order, run for real with only the node's two
// plan routes stubbed: PUT /plan (savePlan) and GET /plan (plan).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceError, marketplaceApi } from '../src/ui/marketplace/api/client.js';
import type { Plan, PlanRequest } from '../src/ui/marketplace/api/types.js';
import { confirmationTicket, forgetPlanSaves, savePlanFor } from '../src/ui/marketplace/purchase/planSaves.js';

const SERVICE = `0x${'14'.repeat(32)}`;
const planOf = (value: string, source: PlanRequest['source'] = { kind: 'wallet' }, renew = true): PlanRequest => ({
  services: [{ serviceId: SERVICE, serviceClass: 'inference', value, maxPricePerUnit: '700000000000' }],
  source, renew, ...(renew ? { renewUntilEpoch: 670 } : {}),
});
/** The plan as the node answers it, with the `…Trac` siblings and the account's discount. */
const asNode = (p: PlanRequest): Plan => ({
  services: p.services.map((s) => ({ ...s, valueTrac: '0.0', maxPricePerUnitTrac: '0.0' })),
  source: p.source.kind === 'account' ? { ...p.source, discountBps: 1_000 } : p.source,
  renew: p.renew, ...(p.renewUntilEpoch !== undefined ? { renewUntilEpoch: p.renewUntilEpoch } : {}),
});
const offline = () => new MarketplaceError({ status: 0, code: 'Offline', message: 'Failed to fetch', retryable: true });
const refused = () => new MarketplaceError({ status: 400, code: 'InvalidRequest', message: 'bad plan', retryable: false });

/**
 * The node's plan routes: each PUT waits for `settle(i)` (the i-th PUT) unless
 * `answerAtOnce`; `failReads` GETs fail first. `plan` is what the node holds.
 */
function planNode() {
  const node = { plan: null as PlanRequest | null, puts: [] as PlanRequest[], failReads: 0, answerAtOnce: true };
  const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  vi.spyOn(marketplaceApi, 'savePlan').mockImplementation((p: PlanRequest) => {
    node.puts.push(p);
    const land = () => { node.plan = p; return asNode(p); };
    if (node.answerAtOnce) return Promise.resolve(land());
    return new Promise<Plan>((resolve, reject) => {
      pending.push({ resolve: () => resolve(land()), reject });
    });
  });
  vi.spyOn(marketplaceApi, 'plan').mockImplementation(async () => {
    if (node.failReads > 0) {
      node.failReads -= 1;
      throw offline();
    }
    return node.plan && asNode(node.plan);
  });
  return {
    node,
    /** Answer the i-th PUT: it lands; or, with `err`, it fails, landing first when `lands`. */
    settle(i: number, err?: unknown, lands = false) {
      const p = pending[i];
      if (!err) { p.resolve(); return; }
      if (lands) node.plan = node.puts[i];
      p.reject(err);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('marketplace plan saves', () => {
  afterEach(() => {
    forgetPlanSaves();
    vi.restoreAllMocks();
  });

  it('holds a newer confirmation\'s save until the older one settles, and ends on the newer plan', async () => {
    const { node, settle } = planNode();
    node.answerAtOnce = false;
    const a = planOf('1000000000000000000');
    const b = planOf('2000000000000000000', { kind: 'account', accountId: '7' });
    const first = savePlanFor(confirmationTicket(), a);
    const second = savePlanFor(confirmationTicket(), b);
    await tick();
    // A's PUT is out and held: B's waits in line behind it.
    expect(node.puts).toEqual([a]);
    settle(0);
    await expect(first).resolves.toBe('saved');
    await tick();
    expect(node.puts).toEqual([a, b]);
    settle(1);
    await expect(second).resolves.toBe('saved');
    expect(node.plan).toEqual(b);
  });

  it('sends the newer confirmation\'s save when the older one is refused', async () => {
    const { node, settle } = planNode();
    node.answerAtOnce = false;
    const a = planOf('1000000000000000000');
    const b = planOf('2000000000000000000');
    const first = savePlanFor(confirmationTicket(), a);
    const second = savePlanFor(confirmationTicket(), b);
    await tick();
    settle(0, refused());
    await expect(first).rejects.toMatchObject({ code: 'InvalidRequest' });
    await tick();
    expect(node.puts).toEqual([a, b]);
    settle(1);
    await expect(second).resolves.toBe('saved');
    expect(node.plan).toEqual(b);
  });

  it('drops an older confirmation\'s save once a newer one is saved, whichever answer comes first', async () => {
    const { node } = planNode();
    const older = confirmationTicket();
    const newer = confirmationTicket();
    await expect(savePlanFor(newer, planOf('2000000000000000000'))).resolves.toBe('saved');
    await expect(savePlanFor(older, planOf('1000000000000000000'))).resolves.toBe('superseded');
    expect(node.puts).toHaveLength(1);
    expect(node.plan?.services[0].value).toBe('2000000000000000000');
  });

  it('counts a save whose answer was lost as saved when the node holds its plan', async () => {
    const { node, settle } = planNode();
    node.answerAtOnce = false;
    const older = confirmationTicket();
    const newer = confirmationTicket();
    const b = planOf('2000000000000000000', { kind: 'wallet' }, false);
    const save = savePlanFor(newer, b);
    await tick();
    settle(0, offline(), true);
    await expect(save).resolves.toBe('saved');
    node.answerAtOnce = true;
    await expect(savePlanFor(older, planOf('1000000000000000000'))).resolves.toBe('superseded');
    expect(node.puts).toEqual([b]);
    expect(node.plan).toEqual(b);
  });

  it('holds an older save back while a newer one\'s lost answer cannot be settled, and drops it once the plan shows the newer one', async () => {
    const { node, settle } = planNode();
    node.answerAtOnce = false;
    const older = confirmationTicket();
    const newer = confirmationTicket();
    const b = planOf('2000000000000000000', { kind: 'wallet' }, false);
    const save = savePlanFor(newer, b);
    await tick();
    // B lands, but neither its answer nor a read of the plan comes back.
    node.failReads = 1;
    settle(0, offline(), true);
    await expect(save).rejects.toMatchObject({ code: 'Offline' });
    // A's save comes, and the plan still cannot be read: A does not go.
    node.failReads = 1;
    node.answerAtOnce = true;
    await expect(savePlanFor(older, planOf('1000000000000000000'))).rejects.toMatchObject({ code: 'Offline' });
    expect(node.puts).toEqual([b]);
    // Asked again once the plan can be read, it sees B on the node and goes no further.
    await expect(savePlanFor(older, planOf('1000000000000000000'))).resolves.toBe('superseded');
    expect(node.puts).toEqual([b]);
    expect(node.plan).toEqual(b);
  });

  it('lets an older save go once the plan shows that a newer save whose answer was lost did not land', async () => {
    const { node, settle } = planNode();
    node.answerAtOnce = false;
    const older = confirmationTicket();
    const newer = confirmationTicket();
    const save = savePlanFor(newer, planOf('2000000000000000000'));
    await tick();
    node.failReads = 1;
    settle(0, offline());
    await expect(save).rejects.toMatchObject({ code: 'Offline' });
    node.answerAtOnce = true;
    const a = planOf('1000000000000000000');
    await expect(savePlanFor(older, a)).resolves.toBe('saved');
    expect(node.plan).toEqual(a);
  });
});
