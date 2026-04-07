import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestCluster, stopTestCluster, nodeApi, sleep, type TestNode } from './helpers.js';

const PARANET_ID = 'game-ccl-e2e';
const POLICY_NAME = 'game-readiness';
const POLICY_VERSION = '0.1.0';

function buildGameFacts(swarm: any): Array<[string, ...unknown[]]> {
  const facts: Array<[string, ...unknown[]]> = [
    ['swarm', swarm.id],
    ['current_turn', swarm.id, swarm.currentTurn],
    ['player_count', swarm.id, swarm.playerCount],
    ['game_status', swarm.id, swarm.gameState.status],
  ];

  if ((swarm.gameState?.epochs ?? 0) > 0) {
    facts.push(['epochs_positive', swarm.id]);
  }

  for (const player of swarm.players ?? []) {
    facts.push(['player', swarm.id, player.name]);
  }

  return facts;
}

const POLICY_BODY = `policy: ${POLICY_NAME}
version: ${POLICY_VERSION}
rules:
  - name: ready_swarm
    params: [Swarm]
    all:
      - atom: { pred: swarm, args: ["$Swarm"] }
      - atom: { pred: player_count, args: ["$Swarm", 3] }
      - atom: { pred: game_status, args: ["$Swarm", "active"] }
      - atom: { pred: epochs_positive, args: ["$Swarm"] }
      - count_distinct:
          vars: [Player]
          where:
            - atom: { pred: player, args: ["$Swarm", "$Player"] }
          op: ">="
          value: 3
decisions:
  - name: propose_continue
    params: [Swarm]
    all:
      - atom: { pred: ready_swarm, args: ["$Swarm"] }
`;

describe('OriginTrail Game CCL e2e', () => {
  let nodes: TestNode[];
  let apiA: ReturnType<typeof nodeApi>;
  let apiB: ReturnType<typeof nodeApi>;
  let apiC: ReturnType<typeof nodeApi>;
  let swarmId: string;

  beforeAll(async () => {
    nodes = await startTestCluster(3);
    apiA = nodeApi(nodes[0]);
    apiB = nodeApi(nodes[1]);
    apiC = nodeApi(nodes[2]);
  }, 120_000);

  afterAll(async () => {
    if (nodes) await stopTestCluster(nodes);
  }, 30_000);

  it('evaluates a CCL policy against live game state and publishes the result', async () => {
    await apiA.createContextGraph(PARANET_ID, 'Game CCL E2E', 'CCL policy evaluation using OriginTrail Game state');

    const published = await apiA.publishCclPolicy({
      paranetId: PARANET_ID,
      name: POLICY_NAME,
      version: POLICY_VERSION,
      content: POLICY_BODY,
      description: 'Promote swarms that reached active play with a full party.',
    });

    expect(published.policyUri).toContain('did:dkg:policy:');
    expect(published.status).toBe('proposed');

    const approved = await apiA.approveCclPolicy({
      paranetId: PARANET_ID,
      policyUri: published.policyUri,
    });
    expect(approved.policyUri).toBe(published.policyUri);

    const resolved = await apiA.resolveCclPolicy(PARANET_ID, POLICY_NAME, { includeBody: true });
    expect(resolved.policy?.policyUri).toBe(published.policyUri);
    expect(resolved.policy?.body).toContain('ready_swarm');

    const created = await apiA.create('Alice', 'Consensus Caravan');
    swarmId = created.id;

    await sleep(1500);
    await apiB.join(swarmId, 'Bob');
    await sleep(1000);
    await apiC.join(swarmId, 'Charlie');
    await sleep(2000);

    const started = await apiA.start(swarmId);
    expect(started.status).toBe('traveling');

    await sleep(2000);
    await apiA.vote(swarmId, 'advance', { pace: 2 });
    await sleep(500);
    await apiB.vote(swarmId, 'advance', { pace: 2 });
    await sleep(500);
    await apiC.vote(swarmId, 'advance', { pace: 2 });
    await sleep(5000);

    const swarm = await apiA.swarm(swarmId);
    expect(swarm.currentTurn).toBeGreaterThanOrEqual(2);
    expect(swarm.gameState.status).toBe('active');
    expect(swarm.gameState.epochs).toBeGreaterThan(0);

    const facts = buildGameFacts(swarm);
    const snapshotId = `game-snapshot-${swarm.currentTurn}`;

    const evaluation = await apiA.evaluateCclPolicy({
      paranetId: PARANET_ID,
      name: POLICY_NAME,
      facts,
      snapshotId,
    });

    expect(evaluation.policy.policyUri).toBe(published.policyUri);
    expect(evaluation.result.derived.ready_swarm).toEqual([[swarmId]]);
    expect(evaluation.result.decisions.propose_continue).toEqual([[swarmId]]);

    const publishedEvaluation = await apiA.evaluateCclPolicy({
      paranetId: PARANET_ID,
      name: POLICY_NAME,
      facts,
      snapshotId,
      publishResult: true,
    });

    expect(publishedEvaluation.evaluationUri).toContain('did:dkg:ccl-eval:');
    expect(publishedEvaluation.publish.status).toBeDefined();
    expect(publishedEvaluation.evaluation.result.decisions.propose_continue).toEqual([[swarmId]]);

    const listed = await apiA.listCclEvaluations(PARANET_ID, {
      snapshotId,
      resultKind: 'decision',
      resultName: 'propose_continue',
    });

    expect(listed.evaluations).toHaveLength(1);
    expect(listed.evaluations[0].evaluationUri).toBe(publishedEvaluation.evaluationUri);
    expect(listed.evaluations[0].policyUri).toBe(published.policyUri);
    expect(listed.evaluations[0].results).toEqual([
      expect.objectContaining({
        kind: 'decision',
        name: 'propose_continue',
        tuple: [swarmId],
      }),
    ]);
  }, 90_000);

  it('does not propose continuation for a recruiting swarm without enough players', async () => {
    const created = await apiA.create('Dana', 'Half-Full Caravan');

    expect(created.status).toBe('recruiting');
    expect(created.playerCount).toBe(1);

    const swarm = await apiA.swarm(created.id);
    const facts = buildGameFacts({
      ...swarm,
      gameState: swarm.gameState ?? { status: 'recruiting' },
    });

    const evaluation = await apiA.evaluateCclPolicy({
      paranetId: PARANET_ID,
      name: POLICY_NAME,
      facts,
      snapshotId: `recruiting-${created.id}`,
    });

    expect(evaluation.result.derived.ready_swarm).toEqual([]);
    expect(evaluation.result.decisions.propose_continue).toEqual([]);
  }, 30_000);
});
