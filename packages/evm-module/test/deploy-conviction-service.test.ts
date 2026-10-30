// Unit tests for the deploy steps of service plan periods (OT-RFC-27) and for
// the Hub transaction step they end in:
//   - deploy/active/052c_deploy_conviction_service_storage.ts, which checks the
//     preconditions of the schedule cut-over before it is forwarded;
//   - deploy/active/052d_deploy_service_subscriptions.ts, which refuses to run
//     against a PublishingConviction without coverServiceCost;
//   - deploy/active/052e_deploy_query_inference_storage.ts, which sets the
//     activation epoch to the deployment epoch on development only;
//   - deploy/active/998_initialize_contracts.ts, which sends
//     Hub.setAndReinitializeContracts only when the deployer may, and
//     otherwise prints the transaction for the Hub owner.
// These paths run only on live networks, so each script is exercised here in
// isolation against a mocked HRE, as deploy-998a-registration-deposit.test.ts
// does: no chain, no real deploy.

import * as fs from 'fs';
import * as path from 'path';

import { expect } from 'chai';
import { ethers, Interface } from 'ethers';

import deployStorage from '../deploy/active/052c_deploy_conviction_service_storage';
import deployServiceSubscriptions from '../deploy/active/052d_deploy_service_subscriptions';
import deployQueryInferenceStorage from '../deploy/active/052e_deploy_query_inference_storage';
import initializeContracts from '../deploy/active/998_initialize_contracts';

const abiOf = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abi', `${name}.json`), 'utf-8'));

const HUB = '0x1000000000000000000000000000000000000001';
const PARAMETERS_STORAGE = '0x1000000000000000000000000000000000000002';
const PUBLISHING_CONVICTION = '0x1000000000000000000000000000000000000003';
const PUBLISHING_CONVICTION_AFTER_RUN = '0x1000000000000000000000000000000000000006';
const CSS = '0x1000000000000000000000000000000000000004';
const SS = '0x1000000000000000000000000000000000000005';
const QIS = '0x1000000000000000000000000000000000000007';
const CHRONOS = '0x1000000000000000000000000000000000000008';
const DEPLOYER = '0x2000000000000000000000000000000000000001';
const HUB_OWNER = '0x2000000000000000000000000000000000000002';
const TREASURY = '0x3000000000000000000000000000000000000001';

const CUT_OVER = 1_783_530_141n;
const LATEST = 1_790_000_000;

/** Run `fn` with console.log captured. */
async function captured(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

async function failureOf(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await captured(fn);
  } catch (e) {
    return e as Error;
  }
  return undefined;
}

function storageHre(opts: {
  network?: string;
  environment?: string;
  configured?: string;
  onChain?: bigint;
  treasury?: string;
  publishingConvictionVersion?: string;
  afterRunVersion?: string;
}) {
  const network = opts.network ?? 'base_sepolia_v10';
  const deployed: string[] = [];
  const updates: string[] = [];
  const contracts: Record<string, { evmAddress: string }> = {
    Hub: { evmAddress: HUB },
    ParametersStorage: { evmAddress: PARAMETERS_STORAGE },
    // What 052b leaves in the deployments file: the build this run registers.
    PublishingConviction: { evmAddress: PUBLISHING_CONVICTION_AFTER_RUN },
  };
  if (opts.onChain !== undefined) contracts.ConvictionServiceStorage = { evmAddress: CSS };
  const hre = {
    network: { name: network, config: { environment: opts.environment ?? 'testnet' } },
    ethers: {
      ZeroAddress: ethers.ZeroAddress,
      provider: { getBlock: async () => ({ timestamp: LATEST }) },
      getContractAt: async (name: string, address: string) => {
        if (name === 'ParametersStorage') {
          return { protocolTreasury: async () => opts.treasury ?? ethers.ZeroAddress };
        }
        if (name === 'Hub') return { getContractAddress: async () => PUBLISHING_CONVICTION };
        if (name === 'PublishingConviction') {
          const version =
            address === PUBLISHING_CONVICTION
              ? (opts.publishingConvictionVersion ?? '10.0.8')
              : (opts.afterRunVersion ?? '10.1.0');
          return { version: async () => version };
        }
        if (name === 'ConvictionServiceStorage' && address === CSS) {
          return { exactScheduleFrom: async () => opts.onChain ?? 0n };
        }
        throw new Error(`unexpected getContractAt(${name}, ${address})`);
      },
    },
    helpers: {
      isDeployed: (name: string) => name in contracts,
      deploy: async ({ newContractName }: { newContractName: string }) => {
        deployed.push(newContractName);
        return { exactScheduleFrom: async () => opts.onChain ?? 0n };
      },
      updateContractParameters: async (name: string) => {
        updates.push(name);
      },
      parametersConfig: {
        testnet: {
          ConvictionServiceStorage: { maxPeriodSeconds: '2678400', maxBucketsPerPeriod: '16' },
          overrides:
            opts.configured === undefined
              ? {}
              : { base_sepolia_v10: { ConvictionServiceStorage: { exactScheduleFrom: opts.configured } } },
        },
        mainnet: { overrides: {} },
      },
      contractDeployments: { contracts },
    },
  };
  return { hre, deployed, updates };
}

describe('@unit deploy/052c — ConvictionServiceStorage and the schedule cut-over', () => {
  it('on a mainnet network, deploys nothing, sets no parameters and runs no checks', async () => {
    for (const network of ['base_mainnet', 'gnosis_mainnet']) {
      const { hre, deployed, updates } = storageHre({
        network,
        environment: 'mainnet',
        treasury: TREASURY,
        publishingConvictionVersion: '10.0.7',
        afterRunVersion: '10.0.7',
      });
      const lines = await captured(() => deployStorage(hre as never));
      expect(deployed).to.have.length(0);
      expect(updates).to.have.length(0);
      expect(lines.join('\n')).to.match(
        new RegExp(`${network}: Conviction Account service spending is not deployed on mainnet yet`),
      );
    }
  });

  it('without a configured cut-over, deploys and sets the parameters with no checks', async () => {
    const { hre, deployed, updates } = storageHre({
      treasury: TREASURY,
      publishingConvictionVersion: '10.0.7',
      afterRunVersion: '10.0.7',
    });
    const lines = await captured(() => deployStorage(hre as never));
    expect(deployed).to.deep.equal(['ConvictionServiceStorage']);
    expect(updates).to.deep.equal(['ConvictionServiceStorage']);
    expect(lines.join('\n')).to.match(/no exactScheduleFrom is configured for base_sepolia_v10/);
  });

  it('with the cut-over configured and unset, checks the treasury, the Hub, the build this run leaves and the time, then deploys', async () => {
    const { hre, deployed, updates } = storageHre({ configured: String(CUT_OVER) });
    const lines = await captured(() => deployStorage(hre as never));
    expect(deployed).to.deep.equal(['ConvictionServiceStorage']);
    expect(updates).to.deep.equal(['ConvictionServiceStorage']);
    expect(lines.join('\n')).to.match(/exactScheduleFrom 1783530141 will be set.*this run leaves 10\.1\.0/);
  });

  // Every refusal comes before anything is deployed, so a refused run leaves
  // nothing a later run would take as deployed but unregistered.
  it('refuses while a protocol treasury is wired, before deploying anything', async () => {
    const { hre, deployed, updates } = storageHre({ configured: String(CUT_OVER), treasury: TREASURY });
    const error = await failureOf(() => deployStorage(hre as never));
    expect(error?.message).to.match(/protocolTreasury\(\) is 0x3000/);
    expect(deployed).to.have.length(0);
    expect(updates).to.have.length(0);
  });

  it('refuses while the Hub names a PublishingConviction older than 10.0.8, before deploying anything', async () => {
    for (const version of ['10.0.7', '1.0.0']) {
      const { hre, deployed } = storageHre({ configured: String(CUT_OVER), publishingConvictionVersion: version });
      const error = await failureOf(() => deployStorage(hre as never));
      expect(error?.message).to.match(new RegExp(`names PublishingConviction ${version.replace(/\./g, '\\.')} .*older than 10\\.0\\.8`));
      expect(deployed).to.have.length(0);
    }
  });

  it('refuses a run that would leave a PublishingConviction older than 10.1.0, before deploying anything, and names the redeploy flag', async () => {
    for (const version of ['10.0.8', '10.0.10']) {
      const { hre, deployed } = storageHre({ configured: String(CUT_OVER), afterRunVersion: version });
      const error = await failureOf(() => deployStorage(hre as never));
      expect(error?.message).to.match(new RegExp(`would leave PublishingConviction ${version.replace(/\./g, '\\.')} .*older than 10\\.1\\.0`));
      expect(error?.message).to.match(/contracts\.PublishingConviction\.deployed to false/);
      expect(deployed).to.have.length(0);
    }
  });

  it('refuses a cut-over after the latest block time, before deploying anything', async () => {
    const { hre, deployed } = storageHre({ configured: String(LATEST + 1) });
    const error = await failureOf(() => deployStorage(hre as never));
    expect(error?.message).to.match(/after the latest block time/);
    expect(deployed).to.have.length(0);
  });

  it('skips the checks once the storage holds the same value, and refuses a different one', async () => {
    const same = storageHre({ configured: String(CUT_OVER), onChain: CUT_OVER, treasury: TREASURY, afterRunVersion: '10.0.8' });
    await captured(() => deployStorage(same.hre as never));
    expect(same.deployed).to.deep.equal(['ConvictionServiceStorage']);
    expect(same.updates).to.deep.equal(['ConvictionServiceStorage']);

    const other = storageHre({ configured: String(CUT_OVER), onChain: CUT_OVER - 1n });
    const error = await failureOf(() => deployStorage(other.hre as never));
    expect(error?.message).to.match(/already 1783530140; it is set once/);
    expect(other.deployed).to.have.length(0);
  });
});

describe('@unit deploy/052d — ServiceSubscriptions and PublishingConviction 10.1.0', () => {
  const ssHre = (version: string, opts: { network?: string; environment?: string; configured?: boolean } = {}) => {
    const deployed: string[] = [];
    const network = opts.network ?? 'base_sepolia_v10';
    const hre = {
      network: { name: network, config: { environment: opts.environment ?? 'testnet' } },
      ethers: { getContractAt: async () => ({ version: async () => version }) },
      helpers: {
        deploy: async ({ newContractName }: { newContractName: string }) => {
          deployed.push(newContractName);
        },
        parametersConfig: {
          testnet: {
            overrides:
              opts.configured === false
                ? {}
                : { base_sepolia_v10: { ConvictionServiceStorage: { exactScheduleFrom: String(CUT_OVER) } } },
          },
          mainnet: { overrides: {} },
        },
        contractDeployments: { contracts: { PublishingConviction: { evmAddress: PUBLISHING_CONVICTION } } },
      },
    };
    return { hre, deployed };
  };

  it('deploys against 10.1.0 or later', async () => {
    for (const version of ['10.1.0', '10.1.3', '11.0.0']) {
      const { hre, deployed } = ssHre(version);
      const lines = await captured(() => deployServiceSubscriptions(hre as never));
      expect(deployed).to.deep.equal(['ServiceSubscriptions']);
      expect(lines).to.have.length(0);
    }
  });

  it('on a network that sets the cut-over, refuses an older build and names the redeploy flag', async () => {
    for (const version of ['10.0.8', '10.0.10', '1.0.0']) {
      const { hre, deployed } = ssHre(version);
      const error = await failureOf(() => deployServiceSubscriptions(hre as never));
      expect(error?.message).to.match(/needs PublishingConviction 10\.1\.0 or later on base_sepolia_v10/);
      expect(error?.message).to.match(/contracts\.PublishingConviction\.deployed to false/);
      expect(deployed).to.have.length(0);
    }
  });

  it('on a mainnet network, deploys nothing, whatever build the run leaves', async () => {
    for (const version of ['10.0.7', '10.1.0']) {
      for (const network of ['base_mainnet', 'gnosis_mainnet']) {
        const { hre, deployed } = ssHre(version, { network, environment: 'mainnet' });
        const lines = await captured(() => deployServiceSubscriptions(hre as never));
        expect(deployed).to.have.length(0);
        expect(lines.join('\n')).to.match(
          new RegExp(`${network}: Conviction Account service spending is not deployed on mainnet yet`),
        );
      }
    }
  });

  it('on a network without the cut-over, deploys against an older build with a note, so other deploys go on', async () => {
    for (const where of [
      { network: 'gnosis_chiado_test', environment: 'testnet' },
      { network: 'base_sepolia_v10', environment: 'testnet', configured: false },
    ]) {
      const { hre, deployed } = ssHre('10.0.7', where);
      const lines = await captured(() => deployServiceSubscriptions(hre as never));
      expect(deployed).to.deep.equal(['ServiceSubscriptions']);
      expect(lines.join('\n')).to.match(new RegExp(`${where.network} keeps PublishingConviction 10\\.0\\.7.*stays off`));
    }
  });
});

describe('@unit deploy/052e — QueryInferenceStorage and its activation', () => {
  const qisInterface = new Interface(abiOf('QueryInferenceStorage'));

  const qisHre = (opts: { network?: string; environment?: string; activation?: bigint; currentEpoch?: bigint } = {}) => {
    const deployed: string[] = [];
    const updates: string[] = [];
    const forwarded: Array<[string, string]> = [];
    const qis = {
      interface: qisInterface,
      getAddress: async () => QIS,
      activationEpoch: async () => opts.activation ?? 0n,
    };
    const hre = {
      network: { name: opts.network ?? 'hardhat', config: { environment: opts.environment ?? 'development' } },
      ethers: {
        getContractAt: async (name: string, address: string) => {
          if (name === 'Chronos' && address === CHRONOS) return { getCurrentEpoch: async () => opts.currentEpoch ?? 7n };
          if (name === 'Hub' && address === HUB) {
            return {
              forwardCall: async (target: string, data: string) => {
                forwarded.push([target, data]);
                return { wait: async () => undefined };
              },
            };
          }
          throw new Error(`unexpected getContractAt(${name}, ${address})`);
        },
      },
      helpers: {
        deploy: async ({ newContractName }: { newContractName: string }) => {
          deployed.push(newContractName);
          return qis;
        },
        updateContractParameters: async (name: string) => {
          updates.push(name);
        },
        contractDeployments: { contracts: { Hub: { evmAddress: HUB }, Chronos: { evmAddress: CHRONOS } } },
      },
    };
    return { hre, deployed, updates, forwarded };
  };

  it('on development, deploys, sets the parameters, and sets the activation epoch to the deployment epoch', async () => {
    for (const network of ['hardhat', 'localhost']) {
      const { hre, deployed, updates, forwarded } = qisHre({ network, currentEpoch: 7n });
      const lines = await captured(() => deployQueryInferenceStorage(hre as never));
      expect(deployed).to.deep.equal(['QueryInferenceStorage']);
      expect(updates).to.deep.equal(['QueryInferenceStorage']);
      expect(forwarded).to.deep.equal([[QIS, qisInterface.encodeFunctionData('setActivationEpoch', [7n])]]);
      expect(lines.join('\n')).to.match(/activationEpoch set to the deployment epoch, 7/);
    }
  });

  it('on development, leaves an activation epoch already set as it is', async () => {
    const { hre, deployed, forwarded } = qisHre({ activation: 3n, currentEpoch: 9n });
    await captured(() => deployQueryInferenceStorage(hre as never));
    expect(deployed).to.deep.equal(['QueryInferenceStorage']);
    expect(forwarded).to.have.length(0);
  });

  it('on a testnet, deploys and sets the parameters but leaves the activation epoch unset, and says how to set it', async () => {
    const { hre, deployed, updates, forwarded } = qisHre({ network: 'base_sepolia_v10', environment: 'testnet' });
    const lines = await captured(() => deployQueryInferenceStorage(hre as never));
    expect(deployed).to.deep.equal(['QueryInferenceStorage']);
    expect(updates).to.deep.equal(['QueryInferenceStorage']);
    expect(forwarded).to.have.length(0);
    expect(lines.join('\n')).to.match(/base_sepolia_v10: activationEpoch stays unset.*setActivationEpoch\(currentEpoch \+ 1\)/);
  });

  it('on a mainnet network, deploys nothing and sets nothing', async () => {
    for (const network of ['base_mainnet', 'gnosis_mainnet']) {
      const { hre, deployed, updates, forwarded } = qisHre({ network, environment: 'mainnet' });
      const lines = await captured(() => deployQueryInferenceStorage(hre as never));
      expect(deployed).to.have.length(0);
      expect(updates).to.have.length(0);
      expect(forwarded).to.have.length(0);
      expect(lines.join('\n')).to.match(new RegExp(`${network}: the query/inference pool is not deployed on mainnet yet`));
    }
  });
});

describe('@unit deploy/998 — the Hub transaction, sent or printed for the Hub owner', () => {
  const hubInterface = new Interface(abiOf('Hub'));
  const cssInterface = new Interface(abiOf('ConvictionServiceStorage'));
  const lists = () => ({
    newContracts: [
      { name: 'ConvictionServiceStorage', addr: CSS },
      { name: 'ServiceSubscriptions', addr: SS },
    ],
    newAssetStorageContracts: [],
    contractsForReinitialization: [CSS, SS],
    setParametersEncodedData: [
      {
        contractName: 'ConvictionServiceStorage',
        encodedData: [cssInterface.encodeFunctionData('setExactScheduleFrom', [CUT_OVER])],
      },
    ],
  });

  function hubHre(opts: { environment?: string; multisigOwners?: string[] | 'reverts'; noChanges?: boolean }) {
    const sent: unknown[][] = [];
    const l = opts.noChanges
      ? { newContracts: [], newAssetStorageContracts: [], contractsForReinitialization: [], setParametersEncodedData: [] }
      : lists();
    const hub = {
      interface: hubInterface,
      owner: async () => HUB_OWNER,
      setAndReinitializeContracts: async (...args: unknown[]) => {
        sent.push(args);
        return { wait: async () => undefined };
      },
    };
    const hre = {
      network: { name: 'base_sepolia_v10', config: { environment: opts.environment ?? 'testnet' } },
      getNamedAccounts: async () => ({ deployer: DEPLOYER }),
      ethers: {
        getContractAt: async (nameOrAbi: unknown) => {
          if (nameOrAbi === 'Hub') return hub;
          return {
            getOwners: async () => {
              if (opts.multisigOwners === undefined || opts.multisigOwners === 'reverts') {
                throw new Error('execution reverted');
              }
              return opts.multisigOwners;
            },
          };
        },
      },
      helpers: {
        ...l,
        newHashFunctions: [],
        newScoreFunctions: [],
        getAbi: (name: string) => abiOf(name),
        contractDeployments: {
          contracts: {
            Hub: { evmAddress: HUB },
            ConvictionServiceStorage: { evmAddress: CSS },
            ServiceSubscriptions: { evmAddress: SS },
          },
        },
      },
    };
    return { hre, sent };
  }

  it('sends it when the deployer is the Hub owner', async () => {
    const { hre, sent } = hubHre({});
    (hre as { getNamedAccounts: () => Promise<{ deployer: string }> }).getNamedAccounts = async () => ({
      deployer: HUB_OWNER,
    });
    await captured(() => initializeContracts(hre as never));
    expect(sent).to.have.length(1);
  });

  it('sends it when the deployer is an owner the multisig Hub owner reports', async () => {
    const { hre, sent } = hubHre({ multisigOwners: ['0x2000000000000000000000000000000000000009', DEPLOYER] });
    await captured(() => initializeContracts(hre as never));
    expect(sent).to.have.length(1);
  });

  it('otherwise sends nothing, and prints the transaction and what it does', async () => {
    for (const multisigOwners of ['reverts', ['0x2000000000000000000000000000000000000009']] as const) {
      const { hre, sent } = hubHre({ multisigOwners: multisigOwners as string[] | 'reverts' });
      const lines = await captured(() => initializeContracts(hre as never));
      expect(sent).to.have.length(0);

      const out = lines.join('\n');
      expect(out).to.match(/cannot call Hub\.setAndReinitializeContracts/);
      expect(out).to.contain(`to:    ${HUB}`);
      expect(out).to.contain('ConvictionServiceStorage -> ' + CSS);
      expect(out).to.contain(`1. ${CSS} (ConvictionServiceStorage)`);
      expect(out).to.contain(`ConvictionServiceStorage.setExactScheduleFrom(${CUT_OVER})`);
      expect(out).to.match(/Send it before any further deploy run on this network/);

      const json = lines.find((x) => x.includes('Hub owner transaction (JSON): '))!;
      const tx = JSON.parse(json.split('Hub owner transaction (JSON): ')[1]);
      expect(tx.to).to.equal(HUB);
      expect(tx.value).to.equal('0');
      const decoded = hubInterface.decodeFunctionData('setAndReinitializeContracts', tx.data);
      const l = lists();
      expect(decoded[0].map((c: ethers.Result) => [c[0], c[1]])).to.deep.equal(
        l.newContracts.map((c) => [c.name, c.addr]),
      );
      expect(decoded[1]).to.have.length(0);
      expect([...decoded[2]]).to.deep.equal(l.contractsForReinitialization);
      expect(decoded[3][0][0]).to.equal('ConvictionServiceStorage');
      expect([...decoded[3][0][1]]).to.deep.equal(l.setParametersEncodedData[0].encodedData);
    }
  });

  it('decodes the query/inference parameters it forwards', async () => {
    const qisInterface = new Interface(abiOf('QueryInferenceStorage'));
    const { hre } = hubHre({ multisigOwners: 'reverts' });
    const helpers = (hre as unknown as { helpers: Record<string, unknown> }).helpers;
    (helpers.newContracts as unknown[]).push({ name: 'QueryInferenceStorage', addr: QIS });
    (helpers.contractsForReinitialization as unknown[]).unshift(QIS);
    (helpers.setParametersEncodedData as unknown[]).push({
      contractName: 'QueryInferenceStorage',
      encodedData: [
        qisInterface.encodeFunctionData('setReceiptGraceSeconds', [3_600n]),
        qisInterface.encodeFunctionData('setLambdaBps', [5_000n]),
      ],
    });
    (helpers.contractDeployments as { contracts: Record<string, unknown> }).contracts.QueryInferenceStorage = {
      evmAddress: QIS,
    };
    const out = (await captured(() => initializeContracts(hre as never))).join('\n');
    expect(out).to.contain('QueryInferenceStorage -> ' + QIS);
    expect(out).to.contain(`1. ${QIS} (QueryInferenceStorage)`);
    expect(out).to.contain('QueryInferenceStorage.setReceiptGraceSeconds(3600)');
    expect(out).to.contain('QueryInferenceStorage.setLambdaBps(5000)');
  });

  it('sends nothing in development, or when nothing changed', async () => {
    for (const opts of [{ environment: 'development' }, { noChanges: true }]) {
      const { hre, sent } = hubHre(opts);
      const lines = await captured(() => initializeContracts(hre as never));
      expect(sent).to.have.length(0);
      expect(lines.join('\n')).to.not.match(/Hub owner transaction/);
    }
  });
});
