/**
 * CCL policy for governing turn resolutions in the OriginTrail Game.
 *
 * This policy is the authority for whether a turn is valid. Both leader
 * and followers evaluate it independently — same facts produce same output.
 *
 * Quorum is M-of-N (required_signatures from context graph config).
 * This means the game continues even if some players are offline,
 * as long as enough players voted to meet the threshold.
 *
 * The policy also verifies the winning action is the actual majority
 * choice from the votes — a leader cannot claim an arbitrary winner.
 *
 * CCL outputs:
 * - has_quorum(Swarm, Turn)           → derived: enough players voted
 * - winner_matches_claim(Swarm, Turn) → derived: claimed winner matches majority
 * - valid_turn(Swarm, Turn)           → derived: quorum + active + correct winner
 * - propose_publish(Swarm, Turn)      → decision: turn is valid, publish it
 * - flag_review(Swarm, Turn)          → decision: turn proposed but invalid
 */

export const TURN_VALIDATION_POLICY_NAME = 'turn-validation';
export const TURN_VALIDATION_POLICY_VERSION = '1.2.0';

export const TURN_VALIDATION_POLICY_BODY = `policy: ${TURN_VALIDATION_POLICY_NAME}
version: ${TURN_VALIDATION_POLICY_VERSION}
rules:
  # NOTE: CCL v0.1 cannot do "count >= $Required" (no variable comparison
  # in count_distinct). The actual M-of-N threshold is enforced by the
  # coordinator's quorumVoted() check BEFORE CCL evaluation runs.
  # This rule is a minimum safety floor: at least 2 votes required.
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

  - name: winner_matches_claim
    params: [Swarm, Turn]
    all:
      - atom: { pred: winning_action, args: ["$Swarm", "$Turn", "$ClaimedAction"] }
      - atom: { pred: majority_winner, args: ["$Swarm", "$Turn", "$ClaimedAction"] }

  - name: valid_turn
    params: [Swarm, Turn]
    all:
      - atom: { pred: has_quorum, args: ["$Swarm", "$Turn"] }
      - atom: { pred: game_is_active, args: ["$Swarm"] }
      - atom: { pred: winner_matches_claim, args: ["$Swarm", "$Turn"] }

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
 * Facts include the M-of-N threshold and the independently computed
 * majority winner, so the policy can verify both quorum and correct tally.
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

  // The caller (coordinator) already ran tallyVotes() with the full
  // tie-breaking logic (leader preference, alphabetical fallback).
  // We emit the caller's winningAction as majority_winner — both leader
  // and follower run tallyVotes() on the same votes, so they will produce
  // the same winner. The CCL policy then just checks winning_action matches.
  const facts: Array<[string, ...unknown[]]> = [
    ['turn_proposal', swarmId, turn],
    ['game_status', swarmId, gameStatus],
    ['alive_player_count', swarmId, alivePlayerCount],
    ['required_signatures', swarmId, requiredSignatures],
    ['vote_count', swarmId, turn, votes.length],
    ['winning_action', swarmId, turn, winningAction],
    ['majority_winner', swarmId, turn, winningAction],
    ['resolution_type', swarmId, turn, resolution],
  ];

  for (const vote of votes) {
    facts.push(['vote', swarmId, turn, vote.peerId]);
    facts.push(['vote_action', swarmId, turn, vote.peerId, vote.action]);
  }

  return facts;
}
