// Our scripted bots, registered inside the simulator as opponents for training and evaluation.
//   npx esbuild ml/sparring.ts --bundle --format=iife --outfile=ml/sparring.js
import { decide as v3 } from "../strategy.ts";
import { decide as v1 } from "../versions/v1.ts";
import { decide as rusher } from "../versions/rusher.ts";
declare const ArenaSim: any;
for (const [name, decide] of [["v3", v3], ["v1", v1], ["rusher", rusher]] as const) {
  ArenaSim.registerBot(name, {
    version: "1",
    start: (hello: any) => {
      const match = { id: hello.match_id, rules: hello.rules, pads: hello.pickups, map: hello.map };
      return (obs: any) => decide(obs, match as any);
    },
  });
}
