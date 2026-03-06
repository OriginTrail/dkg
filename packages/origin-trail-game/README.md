# dkg-app-origin-trail-game

OriginTrail Game — a multiplayer game on the [DKG](https://github.com/OriginTrail/dkg-v9). Installable DKG app.

## How it works

- **1 wagon = 1 game.** Minimum 3 players.
- Players vote each turn (travel, hunt, rest, ford, ferry).
- The game master proposes the next state; at least floor(2/3 × N) nodes must sign to advance the game on-chain (via DKG context graph).
- The game grows a context graph over time; the game master cannot cheat without consensus.

## Install into your DKG node

Add this package as a dependency of `dkg-v9`:

```bash
# In the dkg-v9 repo root:
pnpm add dkg-app-origin-trail-game@github:yourorg/oregon-trail-dkg
```

The daemon's app loader discovers it (via `dkgApp` in `package.json`) and serves it at `/apps/origin-trail-game/`.

## Development

```bash
pnpm install
pnpm build        # Build API handler + UI
pnpm dev:ui       # Dev server for UI (with proxy to local node at :9200)
```

## Package structure

```
├── src/              # Backend: game types, engine, wagon-train, API handler
│   ├── game/         # Types (GameState, Action, etc.)
│   ├── engine/       # Game engine (reducer) + wagon train (multiplayer)
│   ├── world/        # World data (locations along the trail)
│   ├── api/          # API handler (DKG app contract)
│   └── index.ts      # Package exports
├── ui/               # Frontend: React/Vite app
│   ├── src/
│   └── index.html
├── dist/             # Built backend (tsc)
├── dist-ui/          # Built frontend (vite build)
└── package.json      # dkgApp manifest
```
