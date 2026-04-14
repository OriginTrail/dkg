import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, getBytes } from 'ethers';
import { HexString } from 'ethers/lib.commonjs/utils/data';
import hre from 'hardhat';

import { KCSignaturesData, NodeAccounts } from './types';
import {
  ContextGraphStorage,
  ContextGraphValueStorage,
  Chronos,
  Hub,
  KnowledgeCollection,
  Token,
} from '../../typechain';

export async function signMessage(
  signer: SignerWithAddress,
  messageHash: string | Uint8Array,
) {
  const packedMessage = getBytes(messageHash);
  const signature = await signer.signMessage(packedMessage);
  const { v, r, s } = ethers.Signature.from(signature);
  const vsValue = BigInt(s) | ((BigInt(v) - BigInt(27)) << BigInt(255));
  const vs = ethers.zeroPadValue(ethers.toBeHex(vsValue), 32);
  return { r, vs };
}

export async function getKCSignaturesData(
  publishingNode: NodeAccounts,
  publisherIdentityId: number,
  receivingNodes: NodeAccounts[],
  merkleRoot: HexString = ethers.keccak256(
    ethers.toUtf8Bytes('test-merkle-root'),
  ),
): Promise<KCSignaturesData> {
  const publisherMessageHash = ethers.solidityPackedKeccak256(
    ['uint72', 'bytes32'],
    [publisherIdentityId, merkleRoot],
  );

  const { r: publisherR, vs: publisherVS } = await signMessage(
    publishingNode.operational,
    publisherMessageHash,
  );

  const receiverRs = [];
  const receiverVSs = [];
  for (const node of receivingNodes) {
    const { r: receiverR, vs: receiverVS } = await signMessage(
      node.operational,
      merkleRoot,
    );
    receiverRs.push(receiverR);
    receiverVSs.push(receiverVS);
  }

  return {
    merkleRoot,
    publisherR,
    publisherVS,
    receiverRs,
    receiverVSs,
  };
}

/**
 * Optional Phase 10 bridge: when supplied, `createKnowledgeCollection` will
 * also register the freshly-published KC into the given Context Graph and
 * seed its per-epoch value entry in `ContextGraphValueStorage`. Required for
 * any test that subsequently calls `RandomSampling.createChallenge`, which
 * needs the CG-side state (the V8 publishing flow does not write it — Phase
 * 8 owns that wiring and lives in a separate worktree at the time of Phase
 * 10's introduction).
 *
 * `cgOpSigner` MUST already be registered in the Hub as a contract via
 * `Hub.setContractAddress("TestStorageOperator", cgOpSigner.address)` so it
 * passes the `onlyContracts` gate on both storages.
 *
 * If `cgId` is undefined, the helper assumes the caller has already created
 * a CG and will fail at the registration call — pass an explicit CG id.
 */
export type Phase10CGBridge = {
  cgId: bigint | number;
  cgOpSigner: SignerWithAddress;
  ContextGraphStorage: ContextGraphStorage;
  ContextGraphValueStorage: ContextGraphValueStorage;
  Chronos: Chronos;
  /** Optional value seed (defaults to 1 ether). Inflated to keep adjusted
   *  totals comfortably above zero across many concurrent KCs. */
  valueWei?: bigint;
  /** Optional value lifetime in epochs (defaults to 100). Long enough that
   *  multi-epoch tests don't accidentally drop the seed. */
  valueLifetimeEpochs?: number;
};

export async function createKnowledgeCollection(
  kcCreator: SignerWithAddress,
  publishingNode: NodeAccounts,
  publishingNodeIdentityId: number,
  receivingNodes: NodeAccounts[],
  receivingNodesIdentityIds: number[],
  contracts: {
    KnowledgeCollection: KnowledgeCollection;
    Token: Token;
  },
  merkleRoot: HexString = ethers.keccak256(
    ethers.toUtf8Bytes('test-merkle-root'),
  ),
  publishOperationId: string = 'test-operation-id',
  knowledgeAssetsAmount: number = 10,
  byteSize: number = 1000,
  epochs: number = 2,
  tokenAmount: bigint = ethers.parseEther('100'),
  isImmutable: boolean = false,
  paymaster: string = ethers.ZeroAddress,
  phase10Bridge?: Phase10CGBridge,
) {
  const signaturesData = await getKCSignaturesData(
    publishingNode,
    publishingNodeIdentityId,
    receivingNodes,
    merkleRoot,
  );

  // Approve tokens
  await contracts.Token.connect(kcCreator).increaseAllowance(
    contracts.KnowledgeCollection.getAddress(),
    tokenAmount,
  );

  // Create knowledge collection
  const tx = await contracts.KnowledgeCollection.connect(
    kcCreator,
  ).createKnowledgeCollection(
    publishOperationId,
    signaturesData.merkleRoot,
    knowledgeAssetsAmount,
    byteSize,
    epochs,
    tokenAmount,
    isImmutable,
    paymaster,
    publishingNodeIdentityId,
    signaturesData.publisherR,
    signaturesData.publisherVS,
    receivingNodesIdentityIds,
    signaturesData.receiverRs,
    signaturesData.receiverVSs,
  );

  const receipt = await tx.wait();
  const collectionId = Number(receipt!.logs[2].topics[1]);

  // Phase 10 bridge — explicit caller-supplied path.
  if (phase10Bridge) {
    const {
      cgId,
      cgOpSigner,
      ContextGraphStorage,
      ContextGraphValueStorage,
      Chronos,
      valueWei = ethers.parseEther('1'),
      valueLifetimeEpochs = 100,
    } = phase10Bridge;
    await ContextGraphStorage.connect(cgOpSigner).registerKCToContextGraph(
      cgId,
      collectionId,
    );
    const currentEpoch = await Chronos.getCurrentEpoch();
    await ContextGraphValueStorage.connect(cgOpSigner).addCGValueForEpochRange(
      cgId,
      currentEpoch,
      valueLifetimeEpochs,
      valueWei,
    );
  } else {
    // Phase 10 bridge — implicit / opt-in path. If the test fixture has both
    // CG storages deployed AND a `TestStorageOperator` sentinel registered in
    // the Hub, transparently bind every published KC into a default open CG
    // and seed its per-epoch value. This lets pre-existing integration tests
    // that publish via V8 still drive `RandomSampling.createChallenge` after
    // Phase 10 lands, without each call site having to know about the bridge.
    //
    // Tests that deliberately want an empty CG-side state (i.e. assert
    // `NoEligibleContextGraph`) MUST avoid registering the operator OR
    // explicitly skip publishing.
    await _autoBridgeKCToDefaultCG(collectionId);
  }

  return { tx, receipt, collectionId };
}

/**
 * Module-scoped lazy-init for the Phase 10 auto-bridge. Caches the resolved
 * Hub/storage references and the default CG id per (deployed Hub address) so
 * a single test run reuses one CG across many `createKnowledgeCollection`
 * calls. Each new fixture (different Hub address) resets the cache.
 */
type AutoBridgeCache = {
  hubAddress: string;
  cgOpSigner: SignerWithAddress;
  ContextGraphStorage: ContextGraphStorage;
  ContextGraphValueStorage: ContextGraphValueStorage;
  Chronos: Chronos;
  defaultCgId: bigint;
};
let _autoBridgeCache: AutoBridgeCache | null = null;

async function _autoBridgeKCToDefaultCG(kcId: number): Promise<void> {
  // Resolve Hub. If the deployment doesn't have a Hub at all (rare: pure
  // standalone unit tests), bail silently.
  let HubCtr: Hub;
  try {
    HubCtr = await hre.ethers.getContract<Hub>('Hub');
  } catch {
    return;
  }
  const hubAddress = await HubCtr.getAddress();

  // Cache invalidation. The Hub address is deterministic across hardhat
  // snapshot resets (deploy script puts it at the same address every time),
  // so a Hub-address compare alone would treat a freshly-reverted chain as
  // "same fixture". Verify the cached default CG still exists on chain;
  // hardhat's `loadFixture` uses snapshots, so a reverted chain forgets the
  // CG even though the Hub address persists.
  if (_autoBridgeCache && _autoBridgeCache.hubAddress === hubAddress) {
    try {
      const latest =
        await _autoBridgeCache.ContextGraphStorage.getLatestContextGraphId();
      if (latest < _autoBridgeCache.defaultCgId) {
        _autoBridgeCache = null;
      }
    } catch {
      _autoBridgeCache = null;
    }
  } else if (_autoBridgeCache) {
    _autoBridgeCache = null;
  }

  if (!_autoBridgeCache) {
    // Sanity-check that all three preconditions hold — if any are missing,
    // the test fixture didn't opt in to Phase 10 bridging and we leave the
    // KC unattached. The picker will revert when called, which is the
    // intended signal that the fixture needs updating.
    let storageAddr: string;
    let valueAddr: string;
    let opAddr: string;
    try {
      storageAddr = await HubCtr.getAssetStorageAddress('ContextGraphStorage');
      valueAddr = await HubCtr.getContractAddress('ContextGraphValueStorage');
      opAddr = await HubCtr.getContractAddress('TestStorageOperator');
    } catch {
      return;
    }
    if (
      storageAddr === ethers.ZeroAddress ||
      valueAddr === ethers.ZeroAddress ||
      opAddr === ethers.ZeroAddress
    ) {
      return;
    }

    // Bind the typechain handles via the well-known deployment names.
    const ContextGraphStorageCtr =
      await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage');
    const ContextGraphValueStorageCtr =
      await hre.ethers.getContract<ContextGraphValueStorage>(
        'ContextGraphValueStorage',
      );
    const ChronosCtr = await hre.ethers.getContract<Chronos>('Chronos');

    // Resolve the operator signer by address (don't assume an account index).
    const signers = await hre.ethers.getSigners();
    const cgOpSigner = signers.find(
      (s) => s.address.toLowerCase() === opAddr.toLowerCase(),
    );
    if (!cgOpSigner) {
      return;
    }

    // Lazily create the default CG.
    const createTx = await ContextGraphStorageCtr.connect(
      cgOpSigner,
    ).createContextGraph(
      cgOpSigner.address, // owner
      [10n, 20n, 30n], // hosting nodes
      [], // participant agents
      2, // requiredSignatures
      0, // metadataBatchId
      1, // publishPolicy = open
      ethers.ZeroAddress,
      0,
    );
    await createTx.wait();
    const defaultCgId = await ContextGraphStorageCtr.getLatestContextGraphId();

    _autoBridgeCache = {
      hubAddress,
      cgOpSigner,
      ContextGraphStorage: ContextGraphStorageCtr,
      ContextGraphValueStorage: ContextGraphValueStorageCtr,
      Chronos: ChronosCtr,
      defaultCgId,
    };
  }

  const c = _autoBridgeCache;
  await c.ContextGraphStorage.connect(c.cgOpSigner).registerKCToContextGraph(
    c.defaultCgId,
    kcId,
  );
  const currentEpoch = await c.Chronos.getCurrentEpoch();
  await c.ContextGraphValueStorage.connect(
    c.cgOpSigner,
  ).addCGValueForEpochRange(
    c.defaultCgId,
    currentEpoch,
    100, // lifetime epochs
    ethers.parseEther('1'),
  );
}
