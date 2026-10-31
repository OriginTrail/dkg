// Unit tests for the deploy steps of service plan periods (OT-RFC-27) and for
// the Hub transaction step they end in:
//   - deploy/active/052c_deploy_conviction_service_storage.ts, which deploys
//     ConvictionServiceStorage and sets its parameters everywhere but on
//     mainnet;
//   - deploy/active/052d_deploy_service_subscriptions.ts, which deploys
//     ServiceSubscriptions and ServiceSubscriptionsWallet, and refuses to run
//     against PublishingConviction 10.1.x, which would count an account
//     funding twice;
//   - deploy/active/052e_deploy_query_inference_storage.ts, which sets the
//     activation epoch to the deployment epoch on development only;
//   - deploy/active/052f_deploy_query_inference_settlement.ts, which deploys
//     QueryInferenceSettlement everywhere but on mainnet;
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
import deployQueryInferenceSettlement from '../deploy/active/052f_deploy_query_inference_settlement';
import initializeContracts from '../deploy/active/998_initialize_contracts';

const abiOf = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abi', `${name}.json`), 'utf-8'));

const HUB = '0x1000000000000000000000000000000000000001';
const PUBLISHING_CONVICTION = '0x1000000000000000000000000000000000000003';
const CSS = '0x1000000000000000000000000000000000000004';
const SS = '0x1000000000000000000000000000000000000005';
const QIS = '0x1000000000000000000000000000000000000007';
const CHRONOS = '0x1000000000000000000000000000000000000008';
const DEPLOYER = '0x2000000000000000000000000000000000000001';
const HUB_OWNER = '0x2000000000000000000000000000000000000002';

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

function storageHre(opts: { network?: string; environment?: string }) {
  const deployed: string[] = [];
  const updates: string[] = [];
  const hre = {
    network: { name: opts.network ?? 'base_sepolia_v10', config: { environment: opts.environment ?? 'testnet' } },
    ethers: {
      getContractAt: async (name: string, address: string) => {
        throw new Error(`unexpected getContractAt(${name}, ${address})`);
      },
    },
    helpers: {
      deploy: async ({ newContractName }: { newContractName: string }) => {
        deployed.push(newContractName);
        return {};
      },
      updateContractParameters: async (name: string) => {
        updates.push(name);
      },
    },
  };
  return { hre, deployed, updates };
}

describe('@unit deploy/052c — ConvictionServiceStorage', () => {
  it('on a mainnet network, deploys nothing and sets no parameters', async () => {
    for (const network of ['base_mainnet', 'gnosis_mainnet']) {
      const { hre, deployed, updates } = storageHre({ network, environment: 'mainnet' });
      const lines = await captured(() => deployStorage(hre as never));
      expect(deployed).to.have.length(0);
      expect(updates).to.have.length(0);
      expect(lines.join('\n')).to.match(
        new RegExp(`${network}: Conviction Account service spending is not deployed on mainnet yet`),
      );
    }
  });

  it('elsewhere, deploys and sets the parameters, with no reads of any other contract', async () => {
    for (const where of [
      { network: 'base_sepolia_v10', environment: 'testnet' },
      { network: 'hardhat', environment: 'development' },
    ]) {
      const { hre, deployed, updates } = storageHre(where);
      const lines = await captured(() => deployStorage(hre as never));
      expect(deployed).to.deep.equal(['ConvictionServiceStorage']);
      expect(updates).to.deep.equal(['ConvictionServiceStorage']);
      expect(lines).to.have.length(0);
    }
  });

  it('needs only the Hub, and the parameters hold no schedule cut-over any more', () => {
    expect(deployStorage.dependencies).to.deep.equal(['Hub']);
    const parameters = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'deployments', 'parameters.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(JSON.stringify(parameters)).to.not.match(/exactScheduleFrom/);
    expect(new Interface(abiOf('ConvictionServiceStorage')).getFunction('exactScheduleFrom')).to.equal(null);
  });
});

describe('@unit deploy/052d — ServiceSubscriptions and PublishingConviction 10.2.0', () => {
  const ssHre = (version: string, opts: { network?: string; environment?: string } = {}) => {
    const deployed: string[] = [];
    const network = opts.network ?? 'base_sepolia_v10';
    const hre = {
      network: { name: network, config: { environment: opts.environment ?? 'testnet' } },
      ethers: { getContractAt: async () => ({ version: async () => version }) },
      helpers: {
        deploy: async ({ newContractName }: { newContractName: string }) => {
          deployed.push(newContractName);
        },
        contractDeployments: { contracts: { PublishingConviction: { evmAddress: PUBLISHING_CONVICTION } } },
      },
    };
    return { hre, deployed };
  };

  it('deploys ServiceSubscriptions, then ServiceSubscriptionsWallet, against 10.2.0 or later', async () => {
    for (const version of ['10.2.0', '10.2.3', '10.10.0', '11.0.0']) {
      const { hre, deployed } = ssHre(version);
      const lines = await captured(() => deployServiceSubscriptions(hre as never));
      expect(deployed).to.deep.equal(['ServiceSubscriptions', 'ServiceSubscriptionsWallet']);
      expect(lines).to.have.length(0);
    }
  });

  it('refuses a run that would leave 10.1.x, which would count an account funding twice, and names the redeploy flag', async () => {
    for (const version of ['10.1.0', '10.1.3']) {
      const { hre, deployed } = ssHre(version);
      const error = await failureOf(() => deployServiceSubscriptions(hre as never));
      expect(error?.message).to.match(/needs PublishingConviction 10\.2\.0 or later on base_sepolia_v10/);
      expect(error?.message).to.match(/counted twice/);
      expect(error?.message).to.match(/contracts\.PublishingConviction\.deployed to false/);
      expect(deployed).to.have.length(0);
    }
  });

  it('on a mainnet network, deploys nothing, whatever build the run leaves', async () => {
    for (const version of ['10.0.7', '10.1.0', '10.2.0']) {
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

  it('against a build with no coverServiceCost, deploys with a note, so other deploys go on', async () => {
    for (const version of ['10.0.7', '10.0.8', '1.0.0']) {
      for (const network of ['gnosis_chiado_test', 'base_sepolia_v10']) {
        const { hre, deployed } = ssHre(version, { network, environment: 'testnet' });
        const lines = await captured(() => deployServiceSubscriptions(hre as never));
        expect(deployed).to.deep.equal(['ServiceSubscriptions', 'ServiceSubscriptionsWallet']);
        expect(lines.join('\n')).to.match(
          new RegExp(`${network} keeps PublishingConviction ${version.replace(/\./g, '\\.')}.*stay off`),
        );
      }
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

describe('@unit deploy/052f — QueryInferenceSettlement', () => {
  const qsHre = (opts: { network: string; environment: string }) => {
    const deployed: string[] = [];
    const hre = {
      network: { name: opts.network, config: { environment: opts.environment } },
      helpers: {
        deploy: async ({ newContractName }: { newContractName: string }) => {
          deployed.push(newContractName);
        },
      },
    };
    return { hre, deployed };
  };

  it('deploys it on development and on a testnet, with no parameters of its own', async () => {
    for (const where of [
      { network: 'hardhat', environment: 'development' },
      { network: 'localhost', environment: 'development' },
      { network: 'base_sepolia_v10', environment: 'testnet' },
    ]) {
      const { hre, deployed } = qsHre(where);
      const lines = await captured(() => deployQueryInferenceSettlement(hre as never));
      expect(deployed).to.deep.equal(['QueryInferenceSettlement']);
      expect(lines).to.have.length(0);
    }
  });

  it('on a mainnet network, deploys nothing', async () => {
    for (const network of ['base_mainnet', 'gnosis_mainnet']) {
      const { hre, deployed } = qsHre({ network, environment: 'mainnet' });
      const lines = await captured(() => deployQueryInferenceSettlement(hre as never));
      expect(deployed).to.have.length(0);
      expect(lines.join('\n')).to.match(new RegExp(`${network}: the query/inference pool is not deployed on mainnet yet`));
    }
  });

  it('runs after every storage it wires', () => {
    expect(deployQueryInferenceSettlement.dependencies).to.include.members([
      'QueryInferenceStorage',
      'ConvictionServiceStorage',
      'Chronos',
      'IdentityStorage',
      'ProfileStorage',
      'ShardingTableStorage',
      'RandomSamplingStorage',
      'ConvictionStakingStorage',
      'ParametersStorage',
    ]);
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
        encodedData: [cssInterface.encodeFunctionData('setMaxBucketsPerPeriod', [12n])],
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
      expect(out).to.contain('ConvictionServiceStorage.setMaxBucketsPerPeriod(12)');
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
