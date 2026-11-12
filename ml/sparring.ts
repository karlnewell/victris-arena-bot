// Our scripted bots, registered inside the simulator as opponents for training and evaluation.
//   npm run sparring        (builds ml/sparring.js; see build_sparring.mjs)
//
// Each bot is registered twice. The plain name (v3, v1, ...) plays the script exactly, so the
// same starting position always gives the same game. The name with an "n" (v3n, v1n, ...) adds
// per-match randomness, so a network training against it cannot memorise one game per map:
// it has to learn to respond.
import { decide as v3 } from "../strategy.ts";
import { decide as starter } from "../starter-strategy.ts";
import { decide as rusher } from "../versions/rusher.ts";
import { decide as v1 } from "../versions/v1.ts";
import { decide as v2 } from "../versions/v2.ts";
import { decide as close } from "./gen/close.ts";
import { decide as far } from "./gen/far.ts";

declare const ArenaSim: any;
type Decide = (obs: any, match: any) => any;

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** A match's worth of quirks, drawn once at the start so each game has its own character. */
function quirks() {
  return {
    /** Chance each tick of taking a random legal step instead of the script's movement. */
    wander: between(0.02, 0.25),
    /** Chance of holding fire on a tick the script would attack. */
    hold: between(0, 0.2),
    /** Chance of aiming a shot beside the enemy, where a side-step would land. */
    lead: between(0, 0.5),
  };
}

function noisy(decide: Decide): Decide {
  return (obs, match) => {
    const q = (match.quirks ??= quirks());
    const turn = decide(obs, match);
    if (obs.self.state !== "idle") return turn;
    if (obs.moves.length && Math.random() < q.wander) {
      delete turn.dash;
      turn.move = pick(obs.moves as { dir: string }[]).dir;
    }
    if (turn.attack && Math.random() < q.hold) delete turn.attack;
    const target = turn.attack?.target;
    if (turn.attack?.name === "ranged" && target && Math.random() < q.lead) {
      turn.attack = { name: "ranged", target: [target[0] + pick([-1, 0, 1]), target[1] + pick([-1, 0, 1])] };
    }
    return turn;
  };
}

const bots: Record<string, Decide> = { v3, v2, v1, rusher, starter, close, far };
for (const [name, decide] of Object.entries(bots)) {
  for (const [label, play] of [[name, decide], [`${name}n`, noisy(decide)]] as const) {
    ArenaSim.registerBot(label, {
      version: "1",
      start: (hello: any) => {
        const match = { id: hello.match_id, rules: hello.rules, pads: hello.pickups, map: hello.map };
        return (obs: any) => play(obs, match as any);
      },
    });
  }
}
