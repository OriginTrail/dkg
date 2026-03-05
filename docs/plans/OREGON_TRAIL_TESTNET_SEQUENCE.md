# Sequence: Join Testnet → Play Oregon Trail from Node UI

**Model:** 1 wagon = 1 game = 1 **context graph** on the Oregon Trail paranet. Each player runs their own node and plays from their Node UI (on their machine). Minimum **3 players** (more allowed). Players vote on the next action; votes are exchanged via the **workspace** between nodes. To advance the game, the **game master** proposes a new entry in the context graph; **at least floor(2/3 × N) nodes must sign** for the entry to pass on-chain (e.g. 3→2, 4→2, 5→3, 6→4). The game grows the context graph over time; the game master cannot advance without consensus. Coordination is through the DKG (workspace + context graph).

```mermaid
sequenceDiagram
    autonumber
    actor PlayerA as Player A
    actor PlayerB as Player B
    actor PlayerC as Player C
    participant NodeA as Node A GM
    participant NodeB as Node B
    participant NodeC as Node C
    participant Workspace as Workspace
    participant CG as Context Graph

    Note over PlayerA, CG: Each player runs node, join testnet, open Node UI on own machine
    PlayerA->>NodeA: start node, open UI
    NodeA->>Workspace: connect to paranet
    PlayerB->>NodeB: start node, open Node UI
    PlayerC->>NodeC: start node, open Node UI
    NodeB->>Workspace: connect to paranet
    NodeC->>Workspace: connect to paranet

    Note over PlayerA, CG: Lobby - wagons are context graphs, min 3 players to create
    PlayerA->>NodeA: Create wagon or Join existing
    NodeA->>Workspace: create wagon, new context graph
    Workspace-->>NodeB: wagon created
    Workspace-->>NodeC: wagon created
    NodeA->>CG: bootstrap context graph
    NodeA-->>PlayerA: wagon view

    Note over PlayerA, CG: Vote on next action - travel, hunt, rest, ford, ferry
    PlayerA->>NodeA: vote Travel pace 2
    PlayerB->>NodeB: vote Rest
    PlayerC->>NodeC: vote Travel pace 2
    NodeA->>Workspace: publish vote
    NodeB->>Workspace: publish vote
    NodeC->>Workspace: publish vote
    Workspace-->>NodeA: all votes
    Workspace-->>NodeB: all votes
    Workspace-->>NodeC: all votes

    Note over NodeA, CG: GM proposes new CG entry - floor 2/3 N signatures to commit on-chain
    NodeA->>NodeA: compute outcome, build new state entry
    NodeA->>NodeB: request signature for CG entry
    NodeA->>NodeC: request signature for CG entry
    NodeB->>NodeB: verify, sign
    NodeC->>NodeC: verify, sign
    NodeB->>NodeA: signature
    NodeC->>NodeA: signature
    NodeA->>CG: commit entry on-chain
    CG-->>NodeA: entry accepted
    CG-->>NodeB: entry accepted
    CG-->>NodeC: entry accepted

    NodeA-->>PlayerA: updated wagon view
    NodeB-->>PlayerB: updated wagon view
    NodeC-->>PlayerC: updated wagon view
```

## Notes

- **1 wagon = 1 game = 1 context graph** on the Oregon Trail paranet. The context graph grows with each turn (one new attested entry per turn).
- **Each player runs one node** and uses the Node UI in their browser (e.g. `http://127.0.0.1:9200/ui` on the machine where the node runs).
- **Minimum 3 players** per wagon; more players allowed. Vote and signature threshold: **floor(2/3 × N)** (e.g. 3→2, 4→2, 5→3, 6→4).
- **Votes** are communicated through the **workspace** (DKG workspace on the Oregon Trail paranet); all nodes see each other’s votes via workspace sync.
- **Game master** proposes the next context-graph entry (next game state). The entry is committed **on-chain** only when at least floor(2/3 × N) nodes have signed it, so the game master cannot advance the game without consensus.
- **Tokens**: Only the **wagon leader (game master)** needs tokens. Committing a turn to the context graph is a DKG publish operation, which requires **testnet TRAC** (publishing fee) and **testnet ETH** (gas on Base Sepolia). Other players only vote and sign (feeless workspace operations) — they need a running node but no tokens.
- **Testnet**: Relay and chain (e.g. Base Sepolia) come from `network/testnet.json`; each user runs their node and joins the same paranet so they share workspace and context graphs.
