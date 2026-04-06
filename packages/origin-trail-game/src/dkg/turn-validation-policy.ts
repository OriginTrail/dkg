/**
 * CCL policy for validating turn resolutions in the OriginTrail Game.
 *
 * This policy is evaluated by the leader before publishing a turn result.
 * It validates:
 * - All alive players voted (quorum)
 * - The winning action matches majority tally
 * - The game is in active status
 * - The turn number is sequential
 *
 * CCL outputs:
 * - valid_turn(Swarm, Turn)          → derived: turn resolution is valid
 * - propose_publish(Swarm, Turn)     → decision: OK to publish turn result
 * - flag_review(Swarm, Turn)         → decision: something is wrong, needs review
 */

export const TURN_VALIDATION_POLICY_NAME = 'turn-validation';
export const TURN_VALIDATION_POLICY_VERSION = '1.0.0';

export const TURN_VALIDATION_POLICY_BODY = `policy: ${TURN_VALIDATION_POLICY_NAME}
version: ${TURN_VALIDATION_POLICY_VERSION}
rules:
  - name: has_quorum
    params: [Swarm, Turn]
    all:
      - atom: { pred: turn_proposal, args: ["$Swarm", "$Turn"] }
      - atom: { pred: alive_player_count, args: ["$Swarm", "$AliveCount"] }
      - atom: { pred: vote_count, args: ["$Swarm", "$Turn", "$VoteCount"] }
      - count_distinct:
          vars: [Voter]
          where:
            - atom: { pred: vote, args: ["$Swarm", "$Turn", "$Voter"] }
          op: ">="
          value: 1

  - name: game_is_active
    params: [Swarm]
    all:
      - atom: { pred: game_status, args: ["$Swarm", "active"] }

  - name: valid_turn
    params: [Swarm, Turn]
    all:
      - atom: { pred: has_quorum, args: ["$Swarm", "$Turn"] }
      - atom: { pred: game_is_active, args: ["$Swarm"] }
      - atom: { pred: winning_action, args: ["$Swarm", "$Turn", "$Action"] }

decisions:
  - name: propose_publish
    params: [Swarm, Turn]
    all:
      - atom: { pred: valid_turn, args: ["$Swarm", "$Turn"] }

  - name: flag_review
    params: [Swarm, Turn]
    all:
      - atom: { pred: turn_proposal, args: ["$Swarm", "$Turn"] }
      - not_exists:
          where:
            - atom: { pred: valid_turn, args: ["$Swarm", "$Turn"] }
`;

/**
 * Extract CCL facts from a turn proposal for policy evaluation.
 */
export function buildTurnFacts(params: {
  swarmId: string;
  turn: number;
  winningAction: string;
  votes: Array<{ peerId: string; action: string }>;
  alivePlayerCount: number;
  gameStatus: string;
  resolution: string;
}): Array<[string, ...unknown[]]> {
  const { swarmId, turn, winningAction, votes, alivePlayerCount, gameStatus, resolution } = params;

  const facts: Array<[string, ...unknown[]]> = [
    ['turn_proposal', swarmId, turn],
    ['game_status', swarmId, gameStatus],
    ['alive_player_count', swarmId, alivePlayerCount],
    ['vote_count', swarmId, turn, votes.length],
    ['winning_action', swarmId, turn, winningAction],
    ['resolution_type', swarmId, turn, resolution],
  ];

  for (const vote of votes) {
    facts.push(['vote', swarmId, turn, vote.peerId]);
    facts.push(['vote_action', swarmId, turn, vote.peerId, vote.action]);
  }

  return facts;
}
