# obsidian-edge

A bot for [Victris Arena](https://victrisarena.com), a 1v1 arena game for programmed bots.

- `strategy.ts` — the decision code (`decide`), no imports, shared by the ladder client and the simulator.
- `bot.ts` — the ladder connection (WebSocket, queueing, reconnects). Uses `HTTPS_PROXY` when set.
- `starter-strategy.ts` — the unmodified starter strategy, kept as a sparring opponent.
- `sim-test.ts` — plays `strategy.ts` against the simulator's bots.

## Setup

```bash
npm install
npm run setup        # downloads the simulator (arena-sim.mjs, not committed)
npm run sim -- 100   # 100 simulated games per opponent
```

## Play on the ladder

The bot token is secret and is not in this repository. Copy `.env.example` to `.env`
(git-ignored) and fill in `ARENA_TOKEN`; `npm start` loads it. Variables set in the
environment also work:

```bash
cp .env.example .env   # then edit
npm start
ARENA_VERSION=v3 ARENA_MATCHES=3 npm start
```

Every change to the strategy should queue as a new version (`v2`, `v3`, …).
