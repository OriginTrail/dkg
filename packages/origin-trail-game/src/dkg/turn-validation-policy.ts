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
export const TURN_VALIDATION_POLICY_VERSION = '1.3.0';

export const TURN_VALIDATION_POLICY_BODY = `policy: ${TURN_VALIDATION_POLICY_NAME}
version: ${TURN_VALIDATION_POLICY_VERSION}
rules:
  # Quorum check: buildTurnFacts() pre-computes whether the M-of-N threshold
  # is met and emits quorum_met(Swarm, Turn) only when votes >= requiredSignatures.
  # This approach avoids the CCL v0.1 limitation of not supporting variable
  # comparison in count_distinct, while ensuring the actual threshold is used.
  - name: has_quorum
    params: [Swarm, Turn]
    all:
      - atom: { pred: turn_proposal, args: ["$Swarm", "$Turn"] }
      - atom: { pred: quorum_met, args: ["$Swarm", "$Turn"] }

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

  // Independently compute majority from votes to prevent a dishonest leader
  // from claiming an arbitrary winner. Uses the same deterministic tie-break
  // as tallyVotes: highest vote count wins; ties broken alphabetically.
  const distinctVoters = new Set(votes.map(v => v.peerId)).size;
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v.action, (tally.get(v.action) ?? 0) + 1);
  const computedWinner = Array.from(tally.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? winningAction;
  const facts: Array<[string, ...unknown[]]> = [
    ['turn_proposal', swarmId, turn],
    ['game_status', swarmId, gameStatus],
    ['alive_player_count', swarmId, alivePlayerCount],
    ['required_signatures', swarmId, requiredSignatures],
    ['vote_count', swarmId, turn, votes.length],
    ['winning_action', swarmId, turn, winningAction],
    ['majority_winner', swarmId, turn, computedWinner],
    ['resolution_type', swarmId, turn, resolution],
  ];

  // Emit quorum_met only when the actual M-of-N threshold is met.
  // This is the pre-computed quorum check that the CCL policy relies on,
  // replacing the hardcoded "value: 2" that CCL v0.1 required.
  if (distinctVoters >= requiredSignatures) {
    facts.push(['quorum_met', swarmId, turn]);
  }

  for (const vote of votes) {
    facts.push(['vote', swarmId, turn, vote.peerId]);
    facts.push(['vote_action', swarmId, turn, vote.peerId, vote.action]);
  }

  return facts;
}
