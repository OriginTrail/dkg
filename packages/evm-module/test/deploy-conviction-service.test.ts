// Unit tests for the deploy steps of subscriptions (OT-RFC-27) and for
// the Hub transaction step they end in:
//   - deploy/active/000_check_service_spending_builds.ts, which refuses, ahead
//     of every deployment of a run of every step or by any single tag, to keep a
//     PublishingConviction 10.1.x, which would count an account funding twice, or
//     a StakingV10 below 10.1.0, which would split every epoch without the pool,
//     so such a refused run strands nothing;
//   - deploy/active/052c_deploy_service_subscriptions_storage.ts, which deploys
//     ServiceSubscriptionsStorage and sets its parameters everywhere but on
//     mainnet;
//   - deploy/active/052d_deploy_service_subscriptions.ts, which deploys
//     ServiceSubscriptions and ServiceSubscriptionsWallet;
//   - deploy/active/052e_deploy_query_inference_storage.ts, which deploys the
//     storage and warns loudly against a StakingKPI below 10.1.0;
//   - deploy/active/052f_deploy_query_inference_settlement.ts, which deploys
//     QueryInferenceSettlement everywhere but on mainnet;
//   - deploy/active/998_initialize_contracts.ts, which sends
//     Hub.setAndReinitializeContracts only when the deployer may, and
//     otherwise prints the transaction for the Hub owner;
//   - deploy/active/998b_activate_query_inference.ts, which sets the
//     activation epoch to the deployment epoch on development only, once
//     every contract is registered and initialized.
// These paths run only on live networks, so each script is exercised here in
// isolation against a mocked HRE, as deploy-998a-registration-deposit.test.ts
// does: no chain, no real deploy.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { expect } from 'chai';
import { ethers, Interface } from 'ethers';
import { DeployFunction } from 'hardhat-deploy/types';

import checkBuilds from '../deploy/active/000_check_service_spending_builds';
import deployStorage from '../deploy/active/052c_deploy_service_subscriptions_storage';
import deployServiceSubscriptions from '../deploy/active/052d_deploy_service_subscriptions';
import deployQueryInferenceStorage from '../deploy/active/052e_deploy_query_inference_storage';
import deployQueryInferenceSettlement from '../deploy/active/052f_deploy_query_inference_settlement';
import initializeContracts from '../deploy/active/998_initialize_contracts';
import activateQueryInference from '../deploy/active/998b_activate_query_inference';
import { Helpers } from '../utils/helpers';

const abiOf = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abi', `${name}.json`), 'utf-8'));

const HUB = '0x1000000000000000000000000000000000000001';
const PUBLISHING_CONVICTION = '0x1000000000000000000000000000000000000003';
const SSS = '0x1000000000000000000000000000000000000004';
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

describe("@unit deploy/000 — the builds service spending needs, checked ahead of a run's deployments", () => {
  const STAKING_V10 = '0x1000000000000000000000000000000000000009';
  const addressOf: Record<string, string> = { PublishingConviction: PUBLISHING_CONVICTION, StakingV10: STAKING_V10 };

  /** A run on `network` that reuses the recorded contracts of `reused`, at those versions. */
  const buildsHre = (reused: Record<string, string>, opts: { network?: string; environment?: string } = {}) => {
    const read: string[] = [];
    const hre = {
      network: { name: opts.network ?? 'base_sepolia_v10', config: { environment: opts.environment ?? 'testnet' } },
      ethers: {
        getContractAt: async (name: string, address: string) => {
          read.push(name);
          if (name in reused && address === addressOf[name]) return { version: async () => reused[name] };
          throw new Error(`unexpected getContractAt(${name}, ${address})`);
        },
      },
      helpers: {
        isDeployed: (name: string) => name in reused,
        contractDeployments: {
          contracts: Object.fromEntries(Object.keys(reused).map((name) => [name, { evmAddress: addressOf[name], deployed: true }])),
        },
      },
    };
    return { hre, read };
  };

  it('lets a run through that deploys both, or keeps a PublishingConviction below 10.1.0 or from 10.2.0 on and a StakingV10 from 10.1.0 on', async () => {
    for (const reused of [
      {},
      { PublishingConviction: '10.0.8' },
      { PublishingConviction: '10.2.0' },
      { PublishingConviction: '11.0.0', StakingV10: '10.1.0' },
      { StakingV10: '10.2.3' },
    ]) {
      const { hre, read } = buildsHre(reused);
      expect(await failureOf(() => checkBuilds(hre as never))).to.equal(undefined);
      expect(read).to.have.members(Object.keys(reused));
    }
  });

  it('refuses a run that would leave PublishingConviction 10.1.x, which would count an account funding twice, and names the redeploy flag', async () => {
    for (const version of ['10.1.0', '10.1.3']) {
      const { hre } = buildsHre({ PublishingConviction: version });
      const error = await failureOf(() => checkBuilds(hre as never));
      expect(error?.message).to.match(/needs PublishingConviction 10\.2\.0 or later on base_sepolia_v10/);
      expect(error?.message).to.match(/counted twice/);
      expect(error?.message).to.match(/contracts\.PublishingConviction\.deployed to false/);
    }
  });

  it('refuses a run that would keep a StakingV10 below 10.1.0, which splits epochs without the pool, and names the redeploy flag', async () => {
    for (const version of ['10.0.4', '10.0.6']) {
      const { hre } = buildsHre({ StakingV10: version });
      const error = await failureOf(() => checkBuilds(hre as never));
      expect(error?.message).to.match(/needs StakingV10 10\.1\.0 or later on base_sepolia_v10/);
      expect(error?.message).to.contain(`${version} at ${STAKING_V10}`);
      expect(error?.message).to.match(/stays in the vault/);
      expect(error?.message).to.match(/contracts\.StakingV10\.deployed to false/);
    }
  });

  it('on a mainnet network, refuses nothing and reads nothing', async () => {
    for (const network of ['base_mainnet', 'gnosis_mainnet']) {
      const { hre, read } = buildsHre({ PublishingConviction: '10.1.0', StakingV10: '10.0.5' }, { network, environment: 'mainnet' });
      expect(await failureOf(() => checkBuilds(hre as never))).to.equal(undefined);
      expect(read).to.have.length(0);
    }
  });

  it('on a development network, refuses nothing and reads nothing, whatever a leftover file records: that run reuses nothing', async () => {
    for (const network of ['hardhat', 'localhost']) {
      const { hre, read } = buildsHre({ PublishingConviction: '10.1.0', StakingV10: '10.0.5' }, { network, environment: 'development' });
      expect(await failureOf(() => checkBuilds(hre as never))).to.equal(undefined);
      expect(read).to.have.length(0);
    }
  });

  // The steps of deploy/active, in the order hardhat-deploy runs them: its
  // DeploymentsManager takes the tagged files in file order, each after its
  // dependencies, in the order they are listed.
  const scriptsDir = path.join(__dirname, '..', 'deploy', 'active');
  const steps = () =>
    fs
      .readdirSync(scriptsDir)
      .filter((file) => file.endsWith('.ts'))
      .sort()
      .map((file) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loaded = require(path.join(scriptsDir, file)) as { default: DeployFunction };
        return { file, func: loaded.default, tags: (loaded.default.tags ?? []) as string[] };
      });
  const orderOf = (all: ReturnType<typeof steps>, tags: string[] = []) => {
    const order: typeof all = [];
    const atTheEnd: typeof all = [];
    const seen = new Set<string>();
    const visit = (step: (typeof all)[number]) => {
      if (seen.has(step.file)) return;
      for (const dependency of step.func.dependencies ?? []) {
        for (const other of all) if (other.tags.includes(dependency)) visit(other);
      }
      if (seen.has(step.file)) return;
      seen.add(step.file);
      (step.func.runAtTheEnd ? atTheEnd : order).push(step);
    };
    for (const step of all) if (tags.length === 0 || tags.some((tag) => step.tags.includes(tag))) visit(step);
    return [...order, ...atTheEnd];
  };

  it('runs first in a run of every step, and in every run by a tag that reaches the steps that need these builds', () => {
    const all = steps();
    const needing = (order: typeof all) => order.some((s) => /^052[de]_/.test(s.file));
    const first = (order: typeof all) => order[0].file;
    const check = '000_check_service_spending_builds.ts';

    const everyStep = orderOf(all);
    expect(first(everyStep)).to.equal(check);
    expect(everyStep.some((s) => s.file.startsWith('052e_'))).to.equal(true);

    const tags = [...new Set(all.flatMap((s) => s.tags))];
    const reaching = tags.filter((tag) => needing(orderOf(all, [tag])));
    expect(reaching).to.include.members(['QueryInferenceStorage', 'ServiceSubscriptions', 'QueryInferenceSettlement', 'StakingKPI', 'v10']);
    for (const tag of reaching) expect(first(orderOf(all, [tag])), `--tags ${tag}`).to.equal(check);
  });

  it('a development run goes past a leftover file, whose addresses hold no code on a new chain, and step 001 then clears its record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-leftover-'));
    const LEFT = '0x3000000000000000000000000000000000000004';
    const NEW_HUB = '0x4000000000000000000000000000000000000001';
    fs.writeFileSync(
      path.join(dir, 'hardhat_contracts.json'),
      JSON.stringify({
        contracts: {
          Hub: { evmAddress: LEFT, version: '1.0.0', deployed: true },
          PublishingConviction: { evmAddress: LEFT, version: '10.2.0', deployed: true },
          StakingV10: { evmAddress: LEFT, version: '10.1.0', deployed: true },
        },
      }),
    );
    const sent: string[] = [];
    const hre = {
      network: { name: 'hardhat', config: { environment: 'development' } },
      config: { paths: { deployments: dir } },
      getNamedAccounts: async () => ({ deployer: DEPLOYER }),
      deployments: {
        deploy: async (name: string) => {
          sent.push(name);
          return { address: NEW_HUB, receipt: { blockNumber: 1 } };
        },
      },
      ethers: {
        // As a chain with no code at an address answers a call there.
        getContractAt: async (_: unknown, address: string) => ({
          version: async () => {
            if (address === LEFT) throw new Error('could not decode result data (value="0x")');
            return '1.0.0';
          },
        }),
      },
      helpers: undefined as unknown as Helpers,
    };
    hre.helpers = new Helpers(hre as never);
    try {
      // The check comes first, so it is what sees the file, not what 001 leaves.
      const order = orderOf(steps()).filter((s) => /^00[01]_/.test(s.file));
      expect(order.map((s) => s.file.split('_')[0])).to.deep.equal(['000', '001']);
      expect(hre.helpers.isDeployed('StakingV10')).to.equal(true);
      const error = await failureOf(async () => {
        for (const step of order) await step.func(hre as never);
      });
      expect(error).to.equal(undefined);
      expect(sent).to.deep.equal(['Hub']);
      expect(Object.keys(hre.helpers.contractDeployments.contracts)).to.deep.equal(['Hub']);
      expect(hre.helpers.contractDeployments.contracts.Hub.evmAddress).to.equal(NEW_HUB);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Each recorded build is flagged as the operator left it. Whatever else the run
  // redeploys, Ask comes before 052e and 052e's storages before 052d, so a
  // refusal in either step would have left a contract recorded and unregistered.
  const OLD_ASK = '0x3000000000000000000000000000000000000001';
  const OLD_PUBLISHING = '0x3000000000000000000000000000000000000002';
  const OLD_STAKING = '0x3000000000000000000000000000000000000003';
  for (const { refused, flag, publishing, staking } of [
    {
      refused: /needs StakingV10 10\.1\.0 or later/,
      flag: 'StakingV10',
      publishing: { version: '10.0.8', deployed: false },
      staking: { version: '10.0.4', deployed: true },
    },
    {
      refused: /needs PublishingConviction 10\.2\.0 or later/,
      flag: 'PublishingConviction',
      publishing: { version: '10.1.3', deployed: true },
      staking: { version: '10.0.4', deployed: false },
    },
  ]) {
    it(`a run refused over ${flag} deploys and records nothing, so the corrected retry registers every contract in the Hub transaction`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-retry-'));
      const file = path.join(dir, 'base_sepolia_v10_contracts.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          contracts: {
            Hub: { evmAddress: HUB, version: '1.0.0', deployed: true },
            Ask: { evmAddress: OLD_ASK, version: '10.0.0', deployed: false },
            PublishingConviction: { evmAddress: OLD_PUBLISHING, ...publishing },
            StakingV10: { evmAddress: OLD_STAKING, ...staking },
          },
        }),
      );

      // One process of `hardhat deploy`, over the real Helpers and the real steps
      // that deploy these contracts, in the order of a run of every step.
      const run = async () => {
        const sent: string[] = [];
        const versionAt: Record<string, string> = { [OLD_PUBLISHING]: publishing.version, [OLD_STAKING]: staking.version };
        const hre = {
          network: { name: 'base_sepolia_v10', config: { environment: 'testnet' } },
          config: { paths: { deployments: dir } },
          getNamedAccounts: async () => ({ deployer: DEPLOYER }),
          deployments: {
            deploy: async (name: string) => {
              sent.push(name);
              return { address: ethers.zeroPadValue(ethers.toBeHex(0x4000n + BigInt(sent.length)), 20), receipt: { blockNumber: 1 } };
            },
          },
          ethers: {
            provider: { getTransactionCount: async () => 0 },
            getContractAt: async (_: unknown, address: string) => ({ version: async () => versionAt[address] ?? '10.2.0' }),
          },
          helpers: undefined as unknown as Helpers,
        };
        hre.helpers = new Helpers(hre as never);
        hre.helpers.updateContractParameters = async () => undefined;
        const wanted = /^(000|020|052b|052c|052d|052e|052f|055)_/;
        const order = orderOf(steps()).filter((s) => wanted.test(s.file));
        expect(order.map((s) => s.file.split('_')[0])).to.deep.equal(['000', '020', '052e', '052c', '052f', '052b', '052d', '055']);
        const error = await failureOf(async () => {
          for (const step of order) await step.func(hre as never);
        });
        return { error, sent, helpers: hre.helpers };
      };

      try {
        const before = fs.readFileSync(file, 'utf-8');
        const first = await run();
        expect(first.error?.message).to.match(refused);
        expect(first.sent).to.have.length(0);
        expect(first.helpers.newContracts).to.have.length(0);
        expect(fs.readFileSync(file, 'utf-8')).to.equal(before);

        // The operator corrects the flag and runs the deploy again.
        const corrected = JSON.parse(before);
        corrected.contracts[flag].deployed = false;
        fs.writeFileSync(file, JSON.stringify(corrected));
        const retried = await run();
        expect(retried.error).to.equal(undefined);
        expect(retried.helpers.newContracts.map((c) => c.name)).to.deep.equal(retried.sent);
        expect(retried.sent).to.have.members([
          'Ask',
          'QueryInferenceStorage',
          'ServiceSubscriptionsStorage',
          'QueryInferenceSettlement',
          'PublishingConviction',
          'ServiceSubscriptions',
          'ServiceSubscriptionsWallet',
          'StakingV10',
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('@unit deploy/052c — ServiceSubscriptionsStorage', () => {
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
      expect(deployed).to.deep.equal(['ServiceSubscriptionsStorage']);
      expect(updates).to.deep.equal(['ServiceSubscriptionsStorage']);
      expect(lines).to.have.length(0);
    }
  });

  it('needs only the Hub, and the parameters hold no schedule cut-over any more', () => {
    expect(deployStorage.dependencies).to.deep.equal(['Hub']);
    const parameters = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'deployments', 'parameters.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(JSON.stringify(parameters)).to.not.match(/exactScheduleFrom/);
    expect(new Interface(abiOf('ServiceSubscriptionsStorage')).getFunction('exactScheduleFrom')).to.equal(null);
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
        const note = lines.find((line) => line.includes(`${network} keeps PublishingConviction ${version},`));
        expect(note, lines.join('\n')).to.contain('stay off');
      }
    }
  });
});

describe('@unit deploy/052e — QueryInferenceStorage, and the StakingV10 and StakingKPI that will read it', () => {
  const STAKING_V10 = '0x1000000000000000000000000000000000000009';
  const STAKING_KPI = '0x100000000000000000000000000000000000000a';

  /** A run on `network` that reuses the recorded contracts of `reused`, at those versions, and deploys the rest. */
  const qisHre = (opts: { network?: string; environment?: string; reused?: Record<string, string> } = {}) => {
    const deployed: string[] = [];
    const updates: string[] = [];
    const reused = opts.reused ?? {};
    const addressOf: Record<string, string> = { StakingV10: STAKING_V10, StakingKPI: STAKING_KPI };
    const hre = {
      network: { name: opts.network ?? 'hardhat', config: { environment: opts.environment ?? 'development' } },
      ethers: {
        getContractAt: async (name: string, address: string) => {
          if (name in reused && address === addressOf[name]) return { version: async () => reused[name] };
          throw new Error(`unexpected getContractAt(${name}, ${address})`);
        },
      },
      helpers: {
        isDeployed: (name: string) => name in reused,
        deploy: async ({ newContractName }: { newContractName: string }) => {
          deployed.push(newContractName);
          return {};
        },
        updateContractParameters: async (name: string) => {
          updates.push(name);
        },
        contractDeployments: {
          contracts: Object.fromEntries(Object.keys(reused).map((name) => [name, { evmAddress: addressOf[name], deployed: true }])),
        },
      },
    };
    return { hre, deployed, updates };
  };

  it('deploys and sets the parameters when the run deploys StakingV10 and StakingKPI, or keeps 10.1.0 or later; the activation waits for 998b', async () => {
    for (const reused of [{}, { StakingV10: '10.1.0', StakingKPI: '10.1.0' }, { StakingV10: '10.2.3', StakingKPI: '11.0.0' }]) {
      for (const [network, environment] of [
        ['hardhat', 'development'],
        ['base_sepolia_v10', 'testnet'],
      ]) {
        const { hre, deployed, updates } = qisHre({ network, environment, reused });
        const lines = await captured(() => deployQueryInferenceStorage(hre as never));
        expect(deployed).to.deep.equal(['QueryInferenceStorage']);
        expect(updates).to.deep.equal(['QueryInferenceStorage']);
        expect(lines).to.have.length(0);
      }
    }
  });

  it('warns loudly when the run keeps a StakingKPI below 10.1.0, whose views leave the pool out, and deploys', async () => {
    const { hre, deployed } = qisHre({
      network: 'base_sepolia_v10',
      environment: 'testnet',
      reused: { StakingV10: '10.1.0', StakingKPI: '10.0.2' },
    });
    const lines = await captured(() => deployQueryInferenceStorage(hre as never));
    expect(deployed).to.deep.equal(['QueryInferenceStorage']);
    expect(lines.join('\n')).to.match(/WARNING.*StakingKPI 10\.0\.2.*leave the query\/inference pool out.*contracts\.StakingKPI\.deployed to false/s);
  });

  it('on a mainnet network, deploys nothing, sets nothing and reads nothing', async () => {
    for (const network of ['base_mainnet', 'gnosis_mainnet']) {
      const { hre, deployed, updates } = qisHre({ network, environment: 'mainnet', reused: { StakingV10: '10.0.5' } });
      const lines = await captured(() => deployQueryInferenceStorage(hre as never));
      expect(deployed).to.have.length(0);
      expect(updates).to.have.length(0);
      expect(lines.join('\n')).to.match(new RegExp(`${network}: the query/inference pool is not deployed on mainnet yet`));
    }
  });

  it('the parameters of each environment that deploys it are the batch bounds and λ, each with its getter and setter, so a run of the step finds them all', () => {
    const parameters = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'deployments', 'parameters.json'), 'utf-8'),
    ) as Record<string, Record<string, Record<string, string>>>;
    const qis = new Interface(abiOf('QueryInferenceStorage'));
    for (const environment of ['development', 'testnet']) {
      const config = parameters[environment].QueryInferenceStorage;
      expect(config, environment).to.deep.equal({ maxItemsPerBatch: '256', maxGroupsPerBatch: '32', lambdaBps: '5000' });
      for (const getter of Object.keys(config)) {
        expect(qis.getFunction(getter), getter).to.not.equal(null);
        expect(qis.getFunction(`set${getter[0].toUpperCase()}${getter.slice(1)}`), getter).to.not.equal(null);
      }
    }
  });
});

describe('@unit deploy/998b — the activation of the query/inference pool', () => {
  const qisInterface = new Interface(abiOf('QueryInferenceStorage'));

  const activationHre = (opts: { network?: string; environment?: string; activation?: bigint; currentEpoch?: bigint; deployed?: boolean } = {}) => {
    const forwarded: Array<[string, string]> = [];
    const qis = { interface: qisInterface, activationEpoch: async () => opts.activation ?? 0n };
    const contracts: Record<string, { evmAddress: string }> = { Hub: { evmAddress: HUB }, Chronos: { evmAddress: CHRONOS } };
    if (opts.deployed !== false) contracts.QueryInferenceStorage = { evmAddress: QIS };
    const hre = {
      network: { name: opts.network ?? 'hardhat', config: { environment: opts.environment ?? 'development' } },
      ethers: {
        getContractAt: async (name: string, address: string) => {
          if (name === 'QueryInferenceStorage' && address === QIS) return qis;
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
      helpers: { contractDeployments: { contracts } },
    };
    return { hre, forwarded };
  };

  it('on development, once every contract is registered and initialized, sets the activation epoch to the current epoch', async () => {
    for (const network of ['hardhat', 'localhost']) {
      const { hre, forwarded } = activationHre({ network, currentEpoch: 7n });
      const lines = await captured(() => activateQueryInference(hre as never));
      expect(forwarded).to.deep.equal([[QIS, qisInterface.encodeFunctionData('setActivationEpoch', [7n])]]);
      expect(lines.join('\n')).to.match(/activationEpoch set to the deployment epoch, 7/);
    }
    expect(activateQueryInference.runAtTheEnd).to.equal(true);
    expect(activateQueryInference.dependencies).to.include.members(['QueryInferenceStorage', 'QueryInferenceSettlement', 'StakingV10']);
  });

  it('on development, leaves an activation epoch already set as it is', async () => {
    const { hre, forwarded } = activationHre({ activation: 3n, currentEpoch: 9n });
    await captured(() => activateQueryInference(hre as never));
    expect(forwarded).to.have.length(0);
  });

  it('on a testnet, leaves the activation epoch unset and says how to set it', async () => {
    const { hre, forwarded } = activationHre({ network: 'base_sepolia_v10', environment: 'testnet' });
    const lines = await captured(() => activateQueryInference(hre as never));
    expect(forwarded).to.have.length(0);
    expect(lines.join('\n')).to.match(/base_sepolia_v10: activationEpoch stays unset.*setActivationEpoch\(currentEpoch \+ 1\)/);
  });

  it('does nothing where the pool is not deployed: on mainnet, and in a run without it', async () => {
    for (const opts of [{ network: 'base_mainnet', environment: 'mainnet' }, { deployed: false }]) {
      const { hre, forwarded } = activationHre(opts);
      await captured(() => activateQueryInference(hre as never));
      expect(forwarded).to.have.length(0);
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
      'ServiceSubscriptionsStorage',
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
  const cssInterface = new Interface(abiOf('ServiceSubscriptionsStorage'));
  const lists = () => ({
    newContracts: [
      { name: 'ServiceSubscriptionsStorage', addr: SSS },
      { name: 'ServiceSubscriptions', addr: SS },
    ],
    newAssetStorageContracts: [],
    contractsForReinitialization: [SSS, SS],
    setParametersEncodedData: [
      {
        contractName: 'ServiceSubscriptionsStorage',
        encodedData: [cssInterface.encodeFunctionData('setMaxBudgetsPerSubscription', [12n])],
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
            ServiceSubscriptionsStorage: { evmAddress: SSS },
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
      expect(out).to.contain('ServiceSubscriptionsStorage -> ' + SSS);
      expect(out).to.contain(`1. ${SSS} (ServiceSubscriptionsStorage)`);
      expect(out).to.contain('ServiceSubscriptionsStorage.setMaxBudgetsPerSubscription(12)');
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
      expect(decoded[3][0][0]).to.equal('ServiceSubscriptionsStorage');
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
        qisInterface.encodeFunctionData('setMaxItemsPerBatch', [256n]),
        qisInterface.encodeFunctionData('setLambdaBps', [5_000n]),
      ],
    });
    (helpers.contractDeployments as { contracts: Record<string, unknown> }).contracts.QueryInferenceStorage = {
      evmAddress: QIS,
    };
    const out = (await captured(() => initializeContracts(hre as never))).join('\n');
    expect(out).to.contain('QueryInferenceStorage -> ' + QIS);
    expect(out).to.contain(`1. ${QIS} (QueryInferenceStorage)`);
    expect(out).to.contain('QueryInferenceStorage.setMaxItemsPerBatch(256)');
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
