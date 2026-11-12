// Obsidian's strategy. No imports and no I/O, so the same code runs in bot.ts on the ladder and
// inside the simulator.
//
// Ideas, all derived from the timing model (every number is read from hello.rules):
//  - A fighter that has just stepped cannot step again for `move_cooldown` ticks (longer when it
//    started the step inside a frostburst). A shot that lands inside that window cannot be
//    side-stepped. We track the enemy's window and fire into it, and keep our own step in reserve.
//  - Frostburst on the enemy opens a long window: cast it, then shoot the tile it steps to.
//  - Within 2 tiles a shot lands the tick it is sent, with no warning: stay at mid range, and use
//    the repulsor to throw off anyone who gets adjacent.
//  - Movement is chosen by scoring every legal landing tile (danger, zone, spacing, pickups).

type Dir = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
type Pos = [number, number];

interface Enemy {
  pos: Pos;
  hp?: number;
  dash_cooldown: number;
  slow_ticks_left: number;
  state?: string;
  state_ticks_left?: number;
}

/** The parts of an observation this bot reads. Every field: /docs/schema/observation.json. */
export interface Observation {
  tick: number;
  self: {
    id?: number;
    pos: Pos;
    hp: number;
    max_hp: number;
    state: string;
    slow_ticks_left?: number;
    cooldowns: Record<string, number>;
  };
  enemies: Enemy[];
  moves: { dir: Dir; tile: Pos }[];
  dashes: { dir: Dir; tile: Pos }[];
  danger: { tile: Pos; tick: number; damage?: number }[];
  pickups: { id?: number; pos: Pos; kind: string; ready_in: number }[];
  areas?: { owner: number; pos: Pos; radius: number; slow: number; ticks_left: number; tiles: Pos[] }[];
  zone: { center: Pos; radius: number; next_radius: number | null; shrinks_in: number | null };
}

/** The parts of hello.rules this bot reads. Every field: /docs/rules. */
interface Rules {
  stats?: { move_cooldown?: number };
  attacks: {
    ranged?: { speed?: number };
    frostburst: { range: number; slow?: number };
    repulsor?: { push?: number };
  };
  pickups?: { first_spawn?: number; health?: { amount: number } };
}

/** One tick's reply: a step or a dash (or neither), then an optional attack. An empty turn is idle. */
export interface Turn {
  move?: Dir;
  dash?: Dir;
  attack?: { name: string; target?: Pos };
}

/** What the bot remembers during one match. */
interface Memory {
  /** The enemy as last seen, and when. */
  seen: { pos: Pos; tick: number; slowed: boolean } | null;
  /** The first tick on which the enemy can step again, as far as we can tell. */
  enemyFreeAt: number;
  /** The tick each pad is next stocked, by pad id, as far as we have seen. */
  padReadyAt: Record<number, number>;
  /** Walking distances to goals we have routed to, by goal tile. */
  fields: Record<string, number[][]>;
}

export interface Match {
  id: string;
  rules: Rules;
  /** From hello: every pickup pad, and the map's rows ('#' = wall). Optional: the bot plays without them. */
  pads?: { id: number; pos: Pos; kind: string }[];
  map?: string[];
  memory?: Memory;
}

/** Spacing: the band of distances we like to hold, and the distance at which shots land unseen. */
const NEAR = 4;
const FAR = 6;
const POINT_BLANK = 2;
/** Ticks spent heading for each corner of the patrol while searching, and how far it is from the centre. */
/** How far we will walk for health once a full heal's worth is missing. */
const HEALTH_REACH = 14;
/** An enemy this close can dash in and shove us the same tick. */
const SHOVE_REACH = 4;
const PATROL_TICKS = 30;
const PATROL_RADIUS = 2;

const dist = (a: Pos, b: Pos) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const same = (a: Pos, b: Pos) => a[0] === b[0] && a[1] === b[1];
const straight = (a: Pos, b: Pos) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Damage landing on tile `p` between `first` and `last` ticks from now (0 = the tick we reply to). */
function damageIn(obs: Observation, p: Pos, first: number, last: number): number {
  let total = 0;
  for (const d of obs.danger) {
    const dt = d.tick - obs.tick;
    if (dt >= first && dt <= last && same(d.tile, p)) total += d.damage ?? 10;
  }
  return total;
}

/** How far outside the safe square `p` is (0 = inside), now and after an announced shrink. */
function outside(obs: Observation, p: Pos): { now: number; next: number } {
  const d = dist(p, obs.zone.center);
  const next = obs.zone.shrinks_in === null ? obs.zone.radius : (obs.zone.next_radius ?? obs.zone.radius);
  return { now: Math.max(0, d - obs.zone.radius), next: Math.max(0, d - next) };
}

/** Steps needed to walk out of the opponent frostburst areas covering `p` (0 = not in one). */
function stepsToLeaveAreas(obs: Observation, p: Pos): number {
  let steps = 0;
  for (const a of obs.areas ?? []) {
    if (a.owner === obs.self.id || !a.slow) continue;
    if (a.tiles.some((t) => same(t, p))) steps = Math.max(steps, a.radius - dist(p, a.pos) + 1);
  }
  return steps;
}

/**
 * Steps needed to walk from `p` to `goal` around walls (a breadth-first search over the map from
 * hello, with the engine's no-corner-cutting rule). Greedy stepping by straight distance gets stuck
 * behind a column; this doesn't. Without a map it falls back to the straight distance.
 */
function walk(match: Match, memory: Memory, p: Pos, goal: Pos): number {
  const map = match.map;
  if (!map) return dist(p, goal);
  const key = `${goal[0]},${goal[1]}`;
  let field = memory.fields[key];
  if (!field) {
    const open = (x: number, y: number) => map[y] !== undefined && map[y]![x] !== undefined && map[y]![x] !== "#";
    field = map.map((row) => Array.from(row, () => Infinity));
    let queue: Pos[] = [];
    // A goal inside a wall (a zone centre can be) is reached at any open tile beside it.
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = goal[0] + dx;
        const y = goal[1] + dy;
        const d = open(goal[0], goal[1]) ? (dx || dy ? Infinity : 0) : 1;
        if (d !== Infinity && open(x, y)) {
          field[y]![x] = d;
          queue.push([x, y]);
        }
      }
    while (queue.length) {
      const next: Pos[] = [];
      for (const [x, y] of queue)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if ((!dx && !dy) || !open(nx, ny) || field[ny]![nx] !== Infinity) continue;
            if (dx && dy && (!open(x + dx, y) || !open(x, y + dy))) continue;
            field[ny]![nx] = field[y]![x]! + 1;
            next.push([nx, ny]);
          }
      queue = next;
    }
    memory.fields[key] = field;
  }
  const d = field[p[1]]?.[p[0]];
  return d === undefined || d === Infinity ? dist(p, goal) + 20 : d;
}

/** Where to go while the enemy is out of sight: where we last saw it, then around the zone's centre. */
function searchGoal(obs: Observation, memory: Memory): Pos {
  if (memory.seen && obs.tick - memory.seen.tick <= 12 && outside(obs, memory.seen.pos).next === 0)
    return memory.seen.pos;
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

/**
 * A pickup worth walking to, or null. Every pad is known from hello, so we head for health when
 * hurt even if the pad is out of sight, trusting what we last saw of it.
 */
function wantedPickup(obs: Observation, match: Match, memory: Memory, enemy: Enemy | undefined): Pos | null {
  const me = obs.self;
  const heal = match.rules.pickups?.health?.amount ?? 0;
  const firstSpawn = match.rules.pickups?.first_spawn ?? 20;
  const cooldown = match.rules.stats?.move_cooldown ?? 2;
  const missing = me.max_hp - me.hp;
  for (const p of obs.pickups) if (p.id !== undefined) memory.padReadyAt[p.id] = obs.tick + p.ready_in;
  const pads = match.pads ?? obs.pickups.map((p, i) => ({ id: p.id ?? -1 - i, pos: p.pos, kind: p.kind }));
  let best: { pos: Pos; value: number } | null = null;
  for (const pad of pads) {
    if (outside(obs, pad.pos).next > 0) continue;
    const seen = obs.pickups.find((p) => same(p.pos, pad.pos));
    const readyIn = seen ? seen.ready_in : Math.max(0, (memory.padReadyAt[pad.id] ?? firstSpawn) - obs.tick);
    const d = walk(match, memory, me.pos, pad.pos);
    // No use arriving long before it restocks.
    if (readyIn > d * cooldown + 2) continue;
    let reach: number;
    if (pad.kind === "health") {
      if (missing < heal / 2) continue;
      reach = missing >= heal ? HEALTH_REACH : 5;
    } else reach = enemy ? 3 : 8;
    if (d > reach) continue;
    // It gets there first: don't race for it.
    if (enemy && walk(match, memory, enemy.pos, pad.pos) < d - 1) continue;
    const value = (pad.kind === "health" ? 100 : 0) - d;
    if (!best || value > best.value) best = { pos: pad.pos, value };
  }
  return best ? best.pos : null;
}

/** Is there a wall or the map edge within `reach` tiles of `p`, going straight away from `from`? */
function wallBehind(match: Match, p: Pos, from: Pos, reach: number): boolean {
  const map = match.map;
  if (!map) return false;
  const dx = Math.sign(p[0] - from[0]);
  const dy = Math.sign(p[1] - from[1]);
  if (!dx && !dy) return false;
  for (let i = 1; i <= reach; i++) {
    const row = map[p[1] + dy * i];
    const cell = row === undefined ? undefined : row[p[0] + dx * i];
    if (cell === undefined || cell === "#") return true;
  }
  return false;
}

/** Update what we know about when the enemy can next step. */
function trackEnemy(obs: Observation, match: Match, memory: Memory, enemy: Enemy | undefined): void {
  if (!enemy) return;
  const cooldown = match.rules.stats?.move_cooldown ?? 2;
  const slow = match.rules.attacks.frostburst.slow ?? 2;
  const last = memory.seen;
  // It stepped during the previous tick: its move cooldown started then.
  if (last && last.tick === obs.tick - 1 && dist(last.pos, enemy.pos) === 1) {
    memory.enemyFreeAt = Math.max(memory.enemyFreeAt, last.tick + cooldown + (last.slowed ? slow : 0));
  }
  // Stunned, or recovering from a dash: it cannot act until the state ends.
  if (enemy.state && enemy.state !== "idle" && enemy.state_ticks_left)
    memory.enemyFreeAt = Math.max(memory.enemyFreeAt, obs.tick + enemy.state_ticks_left);
  memory.seen = { pos: enemy.pos, tick: obs.tick, slowed: enemy.slow_ticks_left > 0 };
}

/** The tick a shot sent now from `from` reaches a target `d` tiles away. */
function landsAt(obs: Observation, match: Match, d: number): number {
  const speed = match.rules.attacks.ranged?.speed ?? 2;
  return obs.tick + Math.ceil(d / speed) - 1;
}

/** Movement phase: score every legal landing tile (and standing still) and take the best. */
function movement(obs: Observation, match: Match, memory: Memory): Turn {
  const me = obs.self;
  const enemy = obs.enemies[0];
  const cooldown = match.rules.stats?.move_cooldown ?? 2;
  // After a step we are stuck on the landing tile this long (longer if we start inside a frostburst).
  const slowed = stepsToLeaveAreas(obs, me.pos) > 0 || (me.slow_ticks_left ?? 0) > 0;
  const stuck = cooldown + (slowed ? (match.rules.attacks.frostburst.slow ?? 2) : 0);
  const pickup = wantedPickup(obs, match, memory, enemy);
  // Outside the zone (or about to be), the way back in comes before everything else.
  const here = outside(obs, me.pos);
  const goal: Pos | null =
    here.now > 0 || here.next > 0 ? obs.zone.center : (pickup ?? (enemy ? null : searchGoal(obs, memory)));

  const score = (tile: Pos, stepping: boolean): number => {
    let s = 0;
    // Hits we could not avoid from this tile: standing, we can still step next tick (if a step
    // is ready); after stepping, we are stuck there until the cooldown ends.
    const canStepNow = obs.moves.length > 0;
    const hardLast = stepping ? stuck - 1 : canStepNow ? 0 : Math.max(0, (me.cooldowns.move ?? 1) - 1);
    s += 1000 * damageIn(obs, tile, 0, hardLast);
    // Hits coming later: we would have to move again.
    s += 15 * damageIn(obs, tile, hardLast + 1, hardLast + 2);
    s += 2 * damageIn(obs, tile, hardLast + 3, 8);
    s += 60 * stepsToLeaveAreas(obs, tile);
    const out = outside(obs, tile);
    s += 600 * out.now + 120 * out.next;
    if (enemy) {
      const d = dist(tile, enemy.pos);
      if (d <= POINT_BLANK) s += 90 * (POINT_BLANK + 1 - d);
      else if (d < NEAR) s += 25 * (NEAR - d);
      else if (d > FAR) s += 18 * (d - FAR);
      // A shove into a wall is a slam and a stun: keep open ground behind us.
      const push = match.rules.attacks.repulsor?.push ?? 3;
      if (d <= SHOVE_REACH && wallBehind(match, tile, enemy.pos, push)) s += d <= POINT_BLANK ? 70 : 30;
      // A step spends the cooldown that dodges the next shot: only step for a reason.
      if (stepping) s += 10;
    }
    if (goal) s += 14 * walk(match, memory, tile, goal) + 0.01 * straight(tile, goal);
    else if (enemy) s += 0.01 * Math.abs(straight(tile, enemy.pos) - 25);
    // Prefer the middle of the zone, where there is room to dodge and the zone ends.
    s += 0.5 * dist(tile, obs.zone.center);
    return s;
  };

  let best: { turn: Turn; s: number } = { turn: {}, s: score(me.pos, false) };
  for (const m of obs.moves) {
    const s = score(m.tile, true);
    if (s < best.s) best = { turn: { move: m.dir }, s };
  }
  // Nothing avoids a hit on foot: dash (invulnerable this tick) to a landing that stays safe.
  if (best.s >= 1000) {
    let dash: { turn: Turn; s: number } | null = null;
    for (const d of obs.dashes) {
      const out = outside(obs, d.tile);
      const s =
        1000 * damageIn(obs, d.tile, 1, 2) +
        600 * out.now +
        120 * out.next +
        60 * stepsToLeaveAreas(obs, d.tile) +
        (enemy ? (dist(d.tile, enemy.pos) <= POINT_BLANK ? 150 : -2 * dist(d.tile, enemy.pos)) : 0);
      if (!dash || s < dash.s) dash = { turn: { dash: d.dir }, s };
    }
    if (dash && dash.s < best.s) best = dash;
  }
  return best.turn;
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
function attack(obs: Observation, match: Match, memory: Memory, from: Pos): Turn["attack"] {
  const enemy = obs.enemies[0];
  if (!enemy) return undefined;
  const cd = (name: string) => obs.self.cooldowns[name] ?? 0;
  const d = dist(from, enemy.pos);
  if (d === 0) return undefined;
  const range = match.rules.attacks.frostburst.range;
  const still = same(from, obs.self.pos);

  // Adjacent: throw it off us (and into a wall, with luck).
  if (d === 1 && cd("repulsor") === 0) return { name: "repulsor" };

  // A shot that lands before the enemy can step again cannot be side-stepped.
  const certain = landsAt(obs, match, d) < memory.enemyFreeAt;
  if (cd("ranged") === 0 && certain) return { name: "ranged", target: enemy.pos };

  // Frostburst on its tile: its next step costs extra, which opens that window. Cast it when the
  // shot will be ready to follow. Sight is only known from where we stand, so cast standing still.
  const inOurFrost = enemy.slow_ticks_left > 0;
  if (still && cd("frostburst") === 0 && d <= range && !inOurFrost && cd("ranged") <= 2)
    return { name: "frostburst", target: enemy.pos };

  if (cd("ranged") === 0) {
    // While it sits in our frostburst, hold the shot for the step it must take; fire as the fuse runs out.
    if (inOurFrost && enemy.slow_ticks_left > 2) return undefined;
    // Otherwise fire freely, unless that would leave the shot on cooldown for the next combo.
    const comboSoon = d <= range && cd("frostburst") > 0 && cd("frostburst") < 4;
    if (!comboSoon || d <= POINT_BLANK) return { name: "ranged", target: enemy.pos };
  }
  return undefined;
}

export function decide(obs: Observation, match: Match): Turn {
  const memory = (match.memory ??= { seen: null, enemyFreeAt: 0, padReadyAt: {}, fields: {} });
  trackEnemy(obs, match, memory, obs.enemies[0]);
  // Stunned or recovering from a dash: nothing to decide meanwhile.
  if (obs.self.state !== "idle") return {};
  const turn = movement(obs, match, memory);
  const fire = attack(obs, match, memory, endTile(obs, turn));
  return fire ? { ...turn, attack: fire } : turn;
}
