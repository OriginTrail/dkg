/**
 * EVMChainAdapter — Profile nodeId support, without a live RPC. The adapter is
 * constructed with init() and its reads stubbed; the preflight static call and
 * sendContractTransaction are captured so the tests can assert exactly which
 * contract, method, arguments and signer a write would use.
 *
 * Covered:
 *   - ensureProfile creates the profile with the caller's nodeId (the node's
 *     peer id bytes), falls back to random bytes when another identity already
 *     holds it (instead of a permanent NodeIdAlreadyExists revert), and keeps
 *     the legacy random nodeId when none is given
 *   - the feature probe reads the bytecode of the Profile the Hub resolves NOW
 *     for the updateNodeId PUSH4 selector
 *   - updateProfileNodeId: unsupported / unchanged / taken send nothing; the
 *     happy path calls Profile.updateNodeId(identityId, nodeId) signed by the
 *     operational key; an admin-only Profile falls back to the admin key
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers, Interface } from 'ethers';
import { encodeProfileNodeIdHex } from '@origintrail-official/dkg-core';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { selectorInDeployedCode } from '../src/evm-selector-probe.js';
import {
  PROFILE_NODE_ID_UPDATE_MIN_VERSION,
  ProfileNodeIdTakenError,
  ProfileNodeIdUpdateUnsupportedError,
  isProfileNodeIdTakenError,
  isProfileNodeIdUpdateUnsupportedError,
  normalizeProfileNodeId,
} from '../src/profile-node-id.js';

const OPERATIONAL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // hardhat #0
const ADMIN_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // hardhat #1
const OPERATIONAL = new ethers.Wallet(OPERATIONAL_PK).address;
const ADMIN = new ethers.Wallet(ADMIN_PK).address;
const PROFILE_ADDRESS = ethers.getAddress('0x' + '5a'.repeat(20));

const PEER_ID = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const PEER_NODE_ID = encodeProfileNodeIdHex(PEER_ID);
const LEGACY_NODE_ID = '0x' + '7c'.repeat(32);

const profileInterface = new Interface(loadAbi('Profile') as ethers.InterfaceAbi);
const UPDATE_NODE_ID_SELECTOR = profileInterface.getFunction('updateNodeId(uint72,bytes)')!.selector;
// Runtime bytecode with (and without) a `PUSH4 <updateNodeId selector>` dispatcher entry.
const CODE_WITH_UPDATE = `0x6080604052${'63' + UPDATE_NODE_ID_SELECTOR.slice(2)}1461002a57fe`;
const CODE_WITHOUT_UPDATE = '0x60806040526004361061002a57fe';

const identityInterface = new Interface([
  'event IdentityCreated(uint72 indexed identityId, bytes32 indexed operationalKey, bytes32 indexed adminKey)',
]);

function identityCreatedLog(identityId: bigint) {
  const encoded = identityInterface.encodeEventLog(
    identityInterface.getEvent('IdentityCreated')!,
    [identityId, ethers.ZeroHash, ethers.ZeroHash],
  );
  return { topics: encoded.topics, data: encoded.data };
}

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59997',
    privateKey: OPERATIONAL_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

/** A revert as ethers surfaces a decoded custom error from a static call. */
function customErrorRevert(name: string): Error {
  return Object.assign(new Error(`execution reverted: ${name}`), {
    code: 'CALL_EXCEPTION',
    revert: { name, args: [] },
  });
}

interface AdapterOptions {
  identityId?: bigint;
  currentNodeId?: string;
  takenNodeIds?: string[];
  code?: string;
  version?: string | Error;
  admin?: boolean;
  /** Preflight outcome per `from` address; resolves by default. */
  preflight?: (from: string) => Promise<unknown>;
}

function makeAdapter(opts: AdapterOptions = {}) {
  const a: any = new EVMChainAdapter(minimalConfig(opts.admin === false ? { allowNoAdminSigner: true } : { adminPrivateKey: ADMIN_PK }));
  a.init = async () => undefined;

  const profile = { __name: 'Profile', interface: profileInterface, getAddress: async () => PROFILE_ADDRESS };
  const profileStorage = { __name: 'ProfileStorage' };
  const resolved: string[] = [];
  a.resolveContract = async (name: string) => {
    resolved.push(name);
    if (name === 'Profile') return profile;
    if (name === 'ProfileStorage') return profileStorage;
    return { __name: name };
  };
  a.getIdentityId = async () => opts.identityId ?? 7n;
  a.refreshIdentityIdForAddress = async () => opts.identityId ?? 7n;

  const taken = new Set((opts.takenNodeIds ?? []).map((value) => value.toLowerCase()));
  const reads: Array<{ label: string; method: string; args: unknown[] }> = [];
  a.readContract = async (_contract: unknown, label: string, method: string, ...args: unknown[]) => {
    reads.push({ label, method, args });
    if (method === 'getNodeId') return opts.currentNodeId ?? LEGACY_NODE_ID;
    if (method === 'nodeIdsList') return taken.has(String(args[0]).toLowerCase());
    if (method === 'version') {
      if (opts.version instanceof Error) throw opts.version;
      return opts.version ?? PROFILE_NODE_ID_UPDATE_MIN_VERSION;
    }
    throw new Error(`unexpected read ${method}`);
  };

  const codeReads: string[] = [];
  const provider = {
    getCode: async (address: string) => {
      codeReads.push(address);
      return opts.code ?? CODE_WITH_UPDATE;
    },
  };
  a.readProvider = async (_label: string, fn: (p: unknown) => Promise<unknown>) => fn(provider);

  const preflights: Array<{ fn: string; args: unknown[]; from: string }> = [];
  a.rebindContract = (_contract: unknown, _runner: unknown) => ({
    getFunction: (fn: string) => ({
      staticCall: async (...args: unknown[]) => {
        const overrides = args[args.length - 1] as { from: string };
        preflights.push({ fn, args: args.slice(0, -1), from: overrides.from });
        return opts.preflight ? opts.preflight(overrides.from) : undefined;
      },
    }),
  });

  const sends: Array<{ contract: string; method: string; args: unknown[]; signer: string }> = [];
  a.sendContractTransaction = async (contract: any, method: string, args: unknown[], signer: any) => {
    sends.push({ contract: contract.__name, method, args, signer: signer.address });
    return {
      hash: '0x' + 'ab'.repeat(32),
      blockNumber: 12,
      index: 3,
      status: 1,
      logs: method === 'createProfile' ? [identityCreatedLog(41n)] : [],
    };
  };
  a.contracts.identity = { interface: identityInterface };
  a.contracts.profile = profile;
  return { a, sends, preflights, reads, codeReads, resolved };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureProfile nodeId', () => {
  it("creates the profile with the caller's nodeId (the node's peer id bytes)", async () => {
    const { a, sends, reads } = makeAdapter({ identityId: 0n });
    await expect(a.ensureProfile({ nodeName: 'core-1', nodeId: PEER_NODE_ID, stakeAmount: 0n })).resolves.toBe(41n);

    expect(sends).toEqual([{
      contract: 'Profile',
      method: 'createProfile',
      args: [ADMIN, [], 'core-1', PEER_NODE_ID, 0],
      signer: OPERATIONAL,
    }]);
    // It checked the value was free first.
    expect(reads).toContainEqual({ label: 'profileStorage.nodeIdsList', method: 'nodeIdsList', args: [PEER_NODE_ID] });
  });

  it('accepts the nodeId as raw bytes', async () => {
    const { a, sends } = makeAdapter({ identityId: 0n });
    await a.ensureProfile({ nodeName: 'core-1', nodeId: ethers.getBytes(PEER_NODE_ID), stakeAmount: 0n });
    expect(sends[0].args[3]).toBe(PEER_NODE_ID);
  });

  it('falls back to a random nodeId, with a warning, when another identity holds the peer id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { a, sends } = makeAdapter({ identityId: 0n, takenNodeIds: [PEER_NODE_ID] });
    await expect(a.ensureProfile({ nodeName: 'core-1', nodeId: PEER_NODE_ID, stakeAmount: 0n })).resolves.toBe(41n);

    const written = sends[0].args[3] as string;
    expect(written).not.toBe(PEER_NODE_ID);
    expect(ethers.dataLength(written)).toBe(32);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already registered to another identity'));
  });

  it('keeps the legacy random 32-byte nodeId when none is given', async () => {
    const { a, sends, reads } = makeAdapter({ identityId: 0n });
    await a.ensureProfile({ nodeName: 'core-1', stakeAmount: 0n });
    expect(ethers.dataLength(sends[0].args[3] as string)).toBe(32);
    expect(reads.filter((read) => read.method === 'nodeIdsList')).toEqual([]);
  });

  it('rejects an oversize nodeId before sending anything', async () => {
    const { a, sends } = makeAdapter({ identityId: 0n });
    await expect(a.ensureProfile({ nodeId: '0x' + '11'.repeat(65), stakeAmount: 0n }))
      .rejects.toThrow(/65 bytes; the maximum is 64/);
    expect(sends).toEqual([]);
  });

  it('does not touch the nodeId of an existing profile', async () => {
    const { a, sends } = makeAdapter({ identityId: 9n });
    await expect(a.ensureProfile({ nodeId: PEER_NODE_ID, stakeAmount: 0n })).resolves.toBe(9n);
    expect(sends).toEqual([]);
  });
});

describe('getProfileNodeIdUpdateSupport', () => {
  it("probes the bytecode of the Profile the Hub resolves now", async () => {
    const { a, codeReads, resolved } = makeAdapter();
    await expect(a.getProfileNodeIdUpdateSupport()).resolves.toEqual({
      supported: true,
      profileAddress: PROFILE_ADDRESS,
      profileVersion: '10.1.0',
      requiredVersion: '10.1.0',
    });
    expect(codeReads).toEqual([PROFILE_ADDRESS]);
    expect(resolved).toContain('Profile');
  });

  it('reports a Profile without the selector as unsupported, with its version', async () => {
    const { a } = makeAdapter({ code: CODE_WITHOUT_UPDATE, version: '10.0.2' });
    await expect(a.getProfileNodeIdUpdateSupport()).resolves.toMatchObject({
      supported: false,
      profileVersion: '10.0.2',
      requiredVersion: '10.1.0',
    });
  });

  it('treats an address with no code as unsupported and an unreadable version as null', async () => {
    const { a } = makeAdapter({ code: '0x', version: new Error('call revert exception') });
    await expect(a.getProfileNodeIdUpdateSupport()).resolves.toMatchObject({
      supported: false,
      profileVersion: null,
    });
  });
});

describe('updateProfileNodeId', () => {
  it('calls Profile.updateNodeId(identityId, nodeId) signed by the operational key', async () => {
    const { a, sends, preflights } = makeAdapter({ identityId: 7n });
    const result = await a.updateProfileNodeId(PEER_NODE_ID);

    expect(preflights).toEqual([{ fn: 'updateNodeId', args: [7n, PEER_NODE_ID], from: OPERATIONAL }]);
    expect(sends).toEqual([{ contract: 'Profile', method: 'updateNodeId', args: [7n, PEER_NODE_ID], signer: OPERATIONAL }]);
    expect(result).toEqual({
      identityId: 7n,
      previousNodeId: LEGACY_NODE_ID,
      nodeId: PEER_NODE_ID,
      changed: true,
      signer: OPERATIONAL,
      tx: { hash: '0x' + 'ab'.repeat(32), blockNumber: 12, txIndex: 3, success: true },
    });
  });

  it('falls back to the admin key when the Profile rejects the operational key (admin-only variant)', async () => {
    const { a, sends, preflights } = makeAdapter({
      preflight: async (from) => {
        if (from === OPERATIONAL) throw customErrorRevert('OnlyProfileAdminFunction');
      },
    });
    const result = await a.updateProfileNodeId(PEER_NODE_ID);
    expect(preflights.map((p) => p.from)).toEqual([OPERATIONAL, ADMIN]);
    expect(sends[0].signer).toBe(ADMIN);
    expect(result.signer).toBe(ADMIN);
  });

  it('fails without sending when no configured key is accepted', async () => {
    const { a, sends } = makeAdapter({
      admin: false,
      preflight: async () => { throw customErrorRevert('OnlyProfileAdminOrOperationalAddressesFunction'); },
    });
    await expect(a.updateProfileNodeId(PEER_NODE_ID)).rejects.toThrow(/is allowed to update the nodeId of identity 7/);
    expect(sends).toEqual([]);
  });

  it('surfaces an input revert from the preflight without trying another key or sending', async () => {
    const { a, sends, preflights } = makeAdapter({
      preflight: async () => { throw customErrorRevert('ShardingTableIsFull'); },
    });
    await expect(a.updateProfileNodeId(PEER_NODE_ID)).rejects.toThrow(/ShardingTableIsFull/);
    expect(preflights).toHaveLength(1);
    expect(sends).toEqual([]);
  });

  it('is a no-op without a transaction when the nodeId is already set', async () => {
    const { a, sends, preflights } = makeAdapter({ currentNodeId: PEER_NODE_ID });
    await expect(a.updateProfileNodeId(PEER_NODE_ID)).resolves.toEqual({
      identityId: 7n,
      previousNodeId: PEER_NODE_ID,
      nodeId: PEER_NODE_ID,
      changed: false,
    });
    expect(preflights).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('throws ProfileNodeIdUpdateUnsupportedError on an older Profile, naming the needed version', async () => {
    const { a, sends, preflights } = makeAdapter({ code: CODE_WITHOUT_UPDATE, version: '10.0.2' });
    const error = await a.updateProfileNodeId(PEER_NODE_ID).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProfileNodeIdUpdateUnsupportedError);
    expect(isProfileNodeIdUpdateUnsupportedError(error)).toBe(true);
    expect((error as Error).message).toMatch(/not supported by the deployed Profile contract \(v10\.0\.2 at 0x/);
    expect((error as Error).message).toMatch(/needs Profile >= 10\.1\.0/);
    expect(preflights).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('throws ProfileNodeIdTakenError when another identity holds the nodeId', async () => {
    const { a, sends } = makeAdapter({ takenNodeIds: [PEER_NODE_ID] });
    const error = await a.updateProfileNodeId(PEER_NODE_ID).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProfileNodeIdTakenError);
    expect(isProfileNodeIdTakenError(error)).toBe(true);
    expect((error as ProfileNodeIdTakenError).nodeId).toBe(PEER_NODE_ID);
    expect(sends).toEqual([]);
  });

  it('refuses a node without an identity, and invalid nodeIds, before any read', async () => {
    const { a, sends, reads } = makeAdapter({ identityId: 0n });
    await expect(a.updateProfileNodeId(PEER_NODE_ID)).rejects.toThrow(/no on-chain profile/);
    await expect(a.updateProfileNodeId('0x')).rejects.toThrow(/nodeId is empty/);
    await expect(a.updateProfileNodeId('not-hex')).rejects.toThrow(/bytes or 0x-prefixed hex/);
    expect(reads).toEqual([]);
    expect(sends).toEqual([]);
  });
});

describe('getProfileNodeId / isProfileNodeIdTaken', () => {
  it('reads ProfileStorage for this node, or 0x without an identity', async () => {
    const { a, reads } = makeAdapter({ currentNodeId: PEER_NODE_ID.toUpperCase().replace('0X', '0x') });
    await expect(a.getProfileNodeId()).resolves.toBe(PEER_NODE_ID);
    await expect(a.getProfileNodeId(12n)).resolves.toBe(PEER_NODE_ID);
    expect(reads.map((read) => read.args)).toEqual([[7n], [12n]]);
    const { a: noIdentity } = makeAdapter({ identityId: 0n });
    await expect(noIdentity.getProfileNodeId()).resolves.toBe('0x');
  });

  it('reads nodeIdsList', async () => {
    const { a } = makeAdapter({ takenNodeIds: [PEER_NODE_ID] });
    await expect(a.isProfileNodeIdTaken(PEER_NODE_ID)).resolves.toBe(true);
    await expect(a.isProfileNodeIdTaken(LEGACY_NODE_ID)).resolves.toBe(false);
  });
});

describe('profile-node-id helpers', () => {
  it('matches the selector only as a PUSH4 dispatcher entry', () => {
    const bare = UPDATE_NODE_ID_SELECTOR.slice(2);
    expect(selectorInDeployedCode(CODE_WITH_UPDATE, UPDATE_NODE_ID_SELECTOR)).toBe(true);
    expect(selectorInDeployedCode(CODE_WITH_UPDATE.toUpperCase().replace('0X', '0x'), UPDATE_NODE_ID_SELECTOR)).toBe(true);
    // The same four bytes not preceded by PUSH4 (e.g. inside metadata) do not count.
    expect(selectorInDeployedCode(`0x6080${'64' + bare}00`, UPDATE_NODE_ID_SELECTOR)).toBe(false);
    expect(selectorInDeployedCode(CODE_WITHOUT_UPDATE, UPDATE_NODE_ID_SELECTOR)).toBe(false);
    expect(selectorInDeployedCode(CODE_WITH_UPDATE, '0x1234')).toBe(false);
  });

  it('normalizes nodeIds to lowercase hex within 1..64 bytes', () => {
    expect(normalizeProfileNodeId(PEER_NODE_ID.toUpperCase().replace('0X', '0x'), 't')).toBe(PEER_NODE_ID);
    expect(normalizeProfileNodeId(new Uint8Array(64).fill(1), 't')).toBe('0x' + '01'.repeat(64));
    expect(() => normalizeProfileNodeId(new Uint8Array(0), 't')).toThrow(/empty/);
    expect(() => normalizeProfileNodeId('0x' + '01'.repeat(65), 't')).toThrow(/65 bytes/);
    expect(() => normalizeProfileNodeId('0x123', 't')).toThrow(/0x-prefixed hex/);
  });
});
