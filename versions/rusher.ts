// A sparring opponent: the starter's strategy changed to rush in and shove (a rough stand-in for
// the ladder's close-pressure bots). Original header follows.
// The starter's strategy: what it does each tick. No imports and no I/O, so the same code runs
// in bot.ts on the ladder and inside the simulator, where you can train against it or learn from
// it (see "Your own bots in the simulator" in the simulator guide, /docs/simulator).
//
// Every turn has two phases, movement then attack. Movement dodges what the observation says
// will hit us, keeps inside the shrinking zone, grabs nearby pickups, closes in, and searches when
// the enemy is out of sight; the attack then fires from wherever the movement ends. Every number
// comes from hello.rules, so the bot keeps working when the ladder retunes them.

type Dir = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
type Pos = [number, number];

/** The parts of an observation this bot reads. Every field: /docs/schema/observation.json. */
export interface Observation {
  tick: number;
  self: { pos: Pos; hp: number; max_hp: number; state: string; cooldowns: Record<string, number> };
  enemies: { pos: Pos; dash_cooldown: number; slow_ticks_left: number }[];
  moves: { dir: Dir; tile: Pos }[];
  dashes: { dir: Dir; tile: Pos }[];
  danger: { tile: Pos; tick: number }[];
  pickups: { pos: Pos; kind: string; ready_in: number }[];
  zone: { center: Pos; radius: number; next_radius: number | null; shrinks_in: number | null };
}

/** The parts of hello.rules this bot reads. Every field: /docs/rules. */
interface Rules {
  attacks: { frostburst: { range: number } };
  pickups?: { health?: { amount: number } };
}

/** One tick's reply: a step or a dash (or neither), then an optional attack. An empty turn is idle. */
export interface Turn {
  move?: Dir;
  dash?: Dir;
  attack?: { name: string; target?: Pos };
}

/** What the bot keeps during one match. */
export interface Match {
  id: string;
  rules: Rules;
}

/** How close the bot likes to fight: a choice of strategy, not a rule of the game. */
const FIGHTING_RANGE = 1;
/** Ticks spent heading for each corner of the patrol while searching, and how far it is from the centre. */
const PATROL_TICKS = 30;
const PATROL_RADIUS = 2;

const dist = (a: Pos, b: Pos) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const same = (a: Pos, b: Pos) => a[0] === b[0] && a[1] === b[1];

/**
 * The step toward `goal` that ends closest to it. `observation.moves` lists every step the
 * engine would accept right now (no walls, no corner cutting, nobody in the way, move off
 * cooldown), so there is no legality code to write. This is greedy, not a path search.
 */
function stepToward(obs: Observation, goal: Pos): Dir | null {
  let best: { dir: Dir; score: number } | null = null;
  for (const m of obs.moves) {
    // Chebyshev distance first; the straight-line distance breaks ties so we head directly at the goal.
    const score =
      dist(m.tile, goal) * 1000 + (m.tile[0] - goal[0]) ** 2 + (m.tile[1] - goal[1]) ** 2;
    if (!best || score < best.score) best = { dir: m.dir, score };
  }
  return best ? best.dir : null;
}

/**
 * Is tile `p` hit by an opponent attack between `first` and `last` ticks from now
 * (0 = the tick we're replying to)? `observation.danger` lists every tile each visible
 * projectile and area will hit, and on which tick, so there's no geometry to do.
 */
function hitIn(obs: Observation, p: Pos, first: number, last: number): boolean {
  return obs.danger.some(
    (d) => same(d.tile, p) && d.tick - obs.tick >= first && d.tick - obs.tick <= last,
  );
}

/** Inside the zone, and inside the next one too once a shrink is announced: outside it hurts every tick. */
function inSafeZone(obs: Observation, p: Pos): boolean {
  const radius = obs.zone.shrinks_in === null ? obs.zone.radius : obs.zone.next_radius!;
  return dist(p, obs.zone.center) <= radius;
}

/** Get off a tile that's about to be hit: step somewhere safe, or dash (invulnerable on its tick). */
function dodge(obs: Observation): Turn | null {
  // Prefer a tile that stays safe for a few ticks, then one that is merely safe this tick.
  for (const last of [2, 0]) {
    for (const m of obs.moves)
      if (!hitIn(obs, m.tile, 0, last) && inSafeZone(obs, m.tile)) return { move: m.dir };
  }
  // `observation.dashes` has each dash's landing tile (shorter than usual when a wall stops it).
  // A dash is invulnerable only on its own tick: land somewhere that stays safe, and in the zone.
  for (const d of obs.dashes)
    if (!hitIn(obs, d.tile, 1, 2) && inSafeZone(obs, d.tile)) return { dash: d.dir };
  return null;
}

/**
 * Where to go while the enemy is out of sight: around the zone's centre, the ground every fight
 * ends on, one corner of a small square at a time. Waiting in one spot is how two bots spend a
 * match either side of a pillar; chasing where the enemy was walks into its range.
 */
function searchGoal(obs: Observation): Pos {
  const r = Math.min(PATROL_RADIUS, Math.max(1, Math.floor(obs.zone.radius / 2)));
  const [cx, cy] = obs.zone.center;
  const corners: Pos[] = [
    [cx - r, cy - r],
    [cx + r, cy - r],
    [cx + r, cy + r],
    [cx - r, cy + r],
  ];
  return corners[Math.floor(obs.tick / PATROL_TICKS) % corners.length]!;
}

/** Movement phase: dodge, stay in the zone, grab a nearby pickup, then close in on the enemy or look for it. */
function movement(obs: Observation, match: Match): Turn {
  const me = obs.self;
  // Something in flight (a shot or a frostburst area) will hit our tile within 2 ticks.
  if (hitIn(obs, me.pos, 0, 2)) {
    const react = dodge(obs);
    if (react) return react;
  }
  // The zone comes before the enemy: standing outside it costs hp every tick.
  if (!inSafeZone(obs, me.pos)) {
    const d = stepToward(obs, obs.zone.center);
    return d ? { move: d } : {};
  }
  const enemy = obs.enemies[0];
  // Pickups are taken just by stepping onto them. Grab a stocked one that's close and inside the
  // zone, unless the enemy is nearer to it, and skip health we'd mostly waste.
  const heal = match.rules.pickups?.health?.amount ?? 0;
  const pickup = obs.pickups
    .filter(
      (p) =>
        p.ready_in === 0 &&
        inSafeZone(obs, p.pos) &&
        !(p.kind === "health" && me.hp > me.max_hp - heal / 2),
    )
    .filter((p) => !enemy || dist(enemy.pos, p.pos) > dist(me.pos, p.pos))
    .sort((a, b) => dist(me.pos, a.pos) - dist(me.pos, b.pos))[0];
  if (pickup && dist(me.pos, pickup.pos) <= (enemy ? 2 : 6)) {
    const d = stepToward(obs, pickup.pos);
    if (d) return { move: d };
  }
  if (!enemy) {
    const d = stepToward(obs, searchGoal(obs));
    return d ? { move: d } : {};
  }
  // Rush: dash to a tile beside the enemy when the shove is ready, to slam it the same tick.
  if (me.cooldowns.repulsor === 0 && dist(me.pos, enemy.pos) > 1) {
    const d = obs.dashes.find((x) => dist(x.tile, enemy.pos) === 1 && !hitIn(obs, x.tile, 1, 2));
    if (d) return { dash: d.dir };
  }
  if (dist(me.pos, enemy.pos) > FIGHTING_RANGE) {
    const d = stepToward(obs, enemy.pos);
    if (d) return { move: d };
  }
  return {};
}

/** Where the movement ends: the step's or dash's landing tile, or where we already stand. */
function endTile(obs: Observation, turn: Turn): Pos {
  const found = turn.move
    ? obs.moves.find((m) => m.dir === turn.move)
    : turn.dash
      ? obs.dashes.find((d) => d.dir === turn.dash)
      : null;
  return found ? found.tile : obs.self.pos;
}

/** Attack phase: fires from `from`, the tile the movement ends on. Each weapon has its own cooldown. */
function attack(obs: Observation, match: Match, from: Pos): Turn["attack"] {
  const enemy = obs.enemies[0];
  if (!enemy) return undefined;
  const ready = (name: string) => obs.self.cooldowns[name] === 0;
  const distance = dist(from, enemy.pos);
  // The repulsor hits every tile around you and needs no target; the other attacks aim at one.
  if (distance === 1 && ready("repulsor")) return { name: "repulsor" };
  // Frostburst explodes after a fuse, so it only catches an enemy that can't dash out: cast it while
  // the enemy's dash is on cooldown. It needs its target in range and in sight from where we end up;
  // we only know sight from where we stand (enemies lists who we can see now), so cast it standing still.
  const still = same(from, obs.self.pos);
  const range = match.rules.attacks.frostburst.range;
  if (
    still &&
    enemy.dash_cooldown > 0 &&
    distance <= range &&
    ready("frostburst") &&
    !enemy.slow_ticks_left
  ) {
    return { name: "frostburst", target: enemy.pos };
  }
  if (ready("ranged")) return { name: "ranged", target: enemy.pos };
  return undefined;
}

export function decide(obs: Observation, match: Match): Turn {
  // Stunned or recovering from a dash: nothing to decide meanwhile.
  if (obs.self.state !== "idle") return {};
  const turn = movement(obs, match);
  const fire = attack(obs, match, endTile(obs, turn));
  return fire ? { ...turn, attack: fire } : turn;
}
