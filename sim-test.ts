// Local test bench: plays strategy.ts against the simulator's built-in bots and the original starter.
//   npx tsx sim-test.ts [games-per-opponent]
import { Game } from "./arena-sim.mjs";
import { decide, type Match } from "./strategy.ts";
import { decide as starterDecide } from "./starter-strategy.ts";

const games = Number(process.argv[2] ?? 100);
const starterCopy = {
  version: "1",
  start(hello: any) {
    const match = { id: "sim", rules: hello.rules };
    return (obs: any) => starterDecide(obs, match);
  },
};
const opponents: [string, unknown][] = [
  ["random", "random"],
  ["ts-starter", "ts-starter"],
  ["starter-copy", starterCopy],
];

for (const [label, opponent] of opponents) {
  const tally: Record<string, number> = { win: 0, loss: 0, draw: 0 };
  const reasons: Record<string, number> = {};
  let hpFor = 0;
  let hpAgainst = 0;
  let rejected = 0;
  let failures = 0;
  const started = Date.now();
  for (let seed = 0; seed < games; seed++) {
    const game = new Game({ seed, opponent });
    const match: Match = { id: `sim-${seed}`, rules: game.hello(1).rules };
    while (!game.over) {
      const obs = game.next(1);
      for (const e of obs.events ?? []) if (e.kind === "rejected") rejected++;
      let turn = {};
      try {
        turn = decide(obs, match);
      } catch (e) {
        failures++;
        console.error(`decide threw on seed ${seed} tick ${obs.tick}:`, e);
      }
      game.step({ 1: turn });
    }
    const end = game.next(1);
    tally[end.result] = (tally[end.result] ?? 0) + 1;
    reasons[end.reason] = (reasons[end.reason] ?? 0) + 1;
    const fighters = game.summary()?.stats?.fighters ?? [];
    hpFor += fighters[0]?.hp ?? 0;
    hpAgainst += fighters[1]?.hp ?? 0;
  }
  console.log(
    `${label}: ${JSON.stringify(tally)} reasons=${JSON.stringify(reasons)} rejected=${rejected} exceptions=${failures} ` +
      `avg_hp=${(hpFor / games).toFixed(1)}/${(hpAgainst / games).toFixed(1)} (${Date.now() - started} ms)`,
  );
}
