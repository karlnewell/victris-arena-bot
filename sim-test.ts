// Local test bench: plays strategy.ts against other strategies in the simulator.
//   npx tsx sim-test.ts [games-per-opponent]
//
// Scripted bots are deterministic, so plain seeds give only a handful of distinct games. Each game
// here swaps sides on odd seeds and replaces a small share of both bots' steps with a random legal
// step (seeded), so the sample is varied and repeatable.
import { Game } from "./arena-sim.mjs";
import { decide } from "./strategy.ts";
import { decide as starterDecide } from "./starter-strategy.ts";
import { decide as v1Decide } from "./versions/v1.ts";
import { decide as v2Decide } from "./versions/v2.ts";
import { decide as rusherDecide } from "./versions/rusher.ts";

type Decide = (obs: any, match: any) => any;
const NOISE = 0.04;

function rng(seed: number): () => number {
  let s = (seed * 2654435761 + 12345) >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function duel(mine: Decide, theirs: Decide, games: number, label: string): void {
  const tally: Record<string, number> = { win: 0, loss: 0, draw: 0 };
  const byMap: Record<string, Record<string, number>> = {};
  const taken: Record<string, number> = {};
  let pads = 0;
  let theirPads = 0;
  let rejected = 0;
  let exceptions = 0;
  const started = Date.now();
  for (let seed = 0; seed < games; seed++) {
    const random = rng(seed);
    const game = new Game({ seed: Math.floor(seed / 2) });
    const me = seed % 2 === 0 ? 1 : 2;
    const fns: Record<number, Decide> = { [me]: mine, [3 - me]: theirs };
    const matches: Record<number, any> = {};
    for (const id of [1, 2]) {
      const hello = game.hello(id);
      matches[id] = { id: `sim-${seed}`, rules: hello.rules, pads: hello.pickups, map: hello.map };
    }
    while (!game.over) {
      const replies: Record<number, any> = {};
      for (const id of [1, 2]) {
        const obs = game.next(id);
        if (id === me) for (const e of obs.events ?? []) if (e.kind === "rejected") rejected++;
        let turn: any = {};
        try {
          turn = fns[id]!(obs, matches[id]) ?? {};
        } catch (e) {
          if (id === me) exceptions++;
          console.error(`decide threw (fighter ${id}, seed ${seed}, tick ${obs.tick}):`, e);
        }
        if (obs.moves.length && !turn.dash && random() < NOISE) {
          const step = obs.moves[Math.floor(random() * obs.moves.length)];
          turn = { ...turn, move: step.dir };
          if (turn.attack?.name === "frostburst") delete turn.attack; // sight is judged from the new tile
        }
        replies[id] = turn;
      }
      game.step(replies);
    }
    const result = game.next(me).result;
    tally[result] = (tally[result] ?? 0) + 1;
    const map = game.hello(1).map_name;
    (byMap[map] ??= {})[result] = (byMap[map]![result] ?? 0) + 1;
    const fighters = game.summary()?.stats?.fighters ?? [];
    const mineStats = fighters.find((f: any) => f.id === me);
    const theirStats = fighters.find((f: any) => f.id !== me);
    pads += mineStats?.pickups?.health ?? 0;
    theirPads += theirStats?.pickups?.health ?? 0;
    for (const [k, v] of Object.entries(mineStats?.taken_by_source ?? {})) taken[k] = (taken[k] ?? 0) + (v as number);
  }
  const perGame = Object.fromEntries(Object.entries(taken).map(([k, v]) => [k, +(v / games).toFixed(1)]));
  console.log(
    `vs ${label}: ${JSON.stringify(tally)} by_map=${JSON.stringify(byMap)} rejected=${rejected} exceptions=${exceptions} ` +
      `health_pads=${pads}/${theirPads} taken_per_game=${JSON.stringify(perGame)} (${Date.now() - started} ms)`,
  );
}

if (process.argv[1]?.endsWith("sim-test.ts")) {
  const games = Number(process.argv[2] ?? 200);
  duel(decide, starterDecide, games, "starter");
  duel(decide, rusherDecide, games, "rusher");
  duel(decide, v1Decide, games, "v1");
  duel(decide, v2Decide, games, "v2");
}
