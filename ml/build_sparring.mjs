// Builds ml/sparring.js, the opponents bundle the simulator loads for training and evaluation.
//   npm run sparring
// Spacing variants of the current strategy are generated from strategy.ts by changing its
// distance constants, so they follow the strategy as it changes.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "strategy.ts"), "utf8");
const variants = {
  close: { NEAR: 2, FAR: 3 }, // crowds the enemy, where shoves and unseen shots happen
  far: { NEAR: 6, FAR: 8 }, // keeps its distance and shoots
};
mkdirSync(join(here, "gen"), { recursive: true });
for (const [name, constants] of Object.entries(variants)) {
  let text = source;
  for (const [key, value] of Object.entries(constants)) {
    const line = new RegExp(`^const ${key} = \\d+;$`, "m");
    if (!line.test(text)) throw new Error(`strategy.ts has no "const ${key} = <number>;" line`);
    text = text.replace(line, `const ${key} = ${value};`);
  }
  writeFileSync(join(here, "gen", `${name}.ts`), text);
}
await build({
  entryPoints: [join(here, "sparring.ts")],
  bundle: true,
  format: "iife",
  outfile: join(here, "sparring.js"),
  logLevel: "warning",
});
console.log("built ml/sparring.js");
