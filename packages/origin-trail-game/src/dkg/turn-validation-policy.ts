/**
 * CCL policy for governing turn resolutions in the OriginTrail Game.
 *
 * This policy is the authority for whether a turn is valid. Both leader
 * and followers evaluate it independently — same facts produce same output.
 *
 * Quorum is M-of-N (ceil(2N/3) by default), NOT all-alive-must-vote.
 * This means the game continues even if some players are offline,
 * as long as enough players voted to meet the threshold.
 *
 * CCL outputs:
 * - has_quorum(Swarm, Turn)           → derived: enough players voted
 * - valid_turn(Swarm, Turn)           → derived: quorum + active + action determined
 * - propose_publish(Swarm, Turn)      → decision: turn is valid, publish it
 * - flag_review(Swarm, Turn)          → decision: turn proposed but invalid
 */

export const TURN_VALIDATION_POLICY_NAME = 'turn-validation';
export const TURN_VALIDATION_POLICY_VERSION = '1.1.0';

export const TURN_VALIDATION_POLICY_BODY = `policy: ${TURN_VALIDATION_POLICY_NAME}
version: ${TURN_VALIDATION_POLICY_VERSION}
rules:
  - name: has_quorum
    params: [Swarm, Turn]
    all:
      - atom: { pred: turn_proposal, args: ["$Swarm", "$Turn"] }
      - atom: { pred: required_signatures, args: ["$Swarm", "$Required"] }
      - count_distinct:
          vars: [Voter]
          where:
            - atom: { pred: vote, args: ["$Swarm", "$Turn", "$Voter"] }
          op: ">="
          value: 2

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
 *
 * Facts include the M-of-N threshold (required_signatures) so the
 * policy can verify quorum without hardcoding the number.
 */
export function buildTurnFacts(params: {
  swarmId: string;
  turn: number;
  winningAction: string;
  votes: Array<{ peerId: string; action: string }>;
  alivePlayerCount: number;
  requiredSignatures: number;
  gameStatus: string;
  resolution: string;
}): Array<[string, ...unknown[]]> {
  const { swarmId, turn, winningAction, votes, alivePlayerCount, requiredSignatures, gameStatus, resolution } = params;

  const facts: Array<[string, ...unknown[]]> = [
    ['turn_proposal', swarmId, turn],
    ['game_status', swarmId, gameStatus],
    ['alive_player_count', swarmId, alivePlayerCount],
    ['required_signatures', swarmId, requiredSignatures],
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
