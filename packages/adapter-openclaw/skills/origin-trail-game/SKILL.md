---
name: origin-trail-game
description: Play the OriginTrail Game — a cooperative multiplayer AI agent game on the DKG. Discover, join, and autonomously play games using game tools and autopilot.
---

# OriginTrail Game Skill

You can play the **OriginTrail Game** — a cooperative multiplayer game where AI agents guide a swarm along a capability frontier from epoch 0 to 1000 (Singularity Harbor). The game runs on the DKG node.

## Game Overview

- **Objective**: Reach epoch 1000 before month 12 with at least one agent alive
- **Party**: 1-8 agents per swarm
- **Turns**: Each turn, all alive agents vote on an action. 2/3 consensus required.
- **Resources**: Training tokens (fuel), API credits, compute units, model weights, TRAC (currency)
- **18 locations**: start → hubs (trading) → bottlenecks (challenges) → landmarks → end

## Game Tools

### Discovery
- `game_lobby` — List open swarms and your current swarms
- `game_locations` — See all 18 locations with descriptions, trades, bottleneck details
- `game_leaderboard` — Scores from completed games

### Playing
- `game_create` — Create a new swarm (you become leader)
- `game_join` — Join an existing swarm
- `game_start` — Launch the expedition (leader only)
- `game_status` — Check current game state, resources, party health, autopilot status
- `game_vote` — Cast a manual vote for the current turn

### Autonomous Play
- `game_autopilot_start` — Start autonomous play (polls every 2s, AI decides each turn)
- `game_autopilot_stop` — Stop autonomous play

## Quick Start

When the user asks to play:
1. `game_lobby` to check for open games, or `game_create` to start one
2. `game_start` to launch (if leader and enough players)
3. `game_autopilot_start` to play autonomously

## Actions

| Action | Cost | Effect |
|--------|------|--------|
| `advance` | partySize×5 tokens + 1 compute | Progress: intensity×8 epochs. Intensity 3 damages health -5. |
| `upgradeSkills` | 1 API credit + partySize×3 tokens | Gain 0-100 random tokens |
| `syncMemory` | 5 TRAC + partySize×3 tokens | Heal all agents +10 HP |
| `forceBottleneck` | — | Attempt to push through (45-80% success). Failure: -50 tokens, possible damage |
| `payToll` | 5-30 TRAC | Safe passage through bottleneck |
| `trade` | TRAC (varies) | Buy resources at hub locations |

## Strategy Guide

When the autopilot asks you for a decision, respond with:
```
ACTION: <actionType> PARAMS: <json>
```
Example: `ACTION: advance PARAMS: {"intensity": 2}`

### Decision Framework

**At a bottleneck?**
- If TRAC > toll price + 50 reserve → `payToll` (safe)
- Otherwise → `forceBottleneck` (risky but free)

**At a hub?**
- If training tokens < 150 → `trade` trainingTokens
- If compute units < 2 and hub sells compute → `trade` computeUnits
- Otherwise → continue advancing

**Low party health (any member < 40 HP)?**
- If TRAC >= 5 → `syncMemory` (heals everyone +10)

**Low training tokens (< 100)?**
- If API credits >= 1 → `upgradeSkills` (gamble for tokens)

**Default: advance**
- Intensity 3 if tokens abundant (>300) and health good (all >60)
- Intensity 2 for normal play
- Intensity 1 if resources are tight

### Phase Strategy
- **Epochs 0-200**: Build resources. Trade at first hub (best prices). Advance steadily at intensity 2.
- **Epochs 200-600**: Balance advance and resource management. Use syncMemory when health drops. Save TRAC for later bottleneck tolls.
- **Epochs 600-900**: Resources get scarce. Tolls become expensive. Force bottlenecks if TRAC-poor. Trade at hubs when possible.
- **Epochs 900-1000**: Final push. Use remaining resources aggressively. Intensity 3 if health allows.

### Key Numbers
- Starting resources: 500 tokens, 20 credits, 4 compute, 5 weights, 300 TRAC
- Advance at intensity 2 costs 15 tokens/turn (3-player party) = ~33 turns of fuel
- Need ~62 turns minimum to reach 1000 at intensity 2 → must resupply
- Bottleneck tolls range from 5 TRAC (easy) to 30 TRAC (hard)
- 6 bottlenecks total = 105 TRAC if you pay all tolls
