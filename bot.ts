// Victris Arena starter bot (TypeScript). Copy this directory to begin your own.
//
//   ARENA_TOKEN=<your token> node --import tsx bots/ts-starter/bot.ts
//
// Environment: ARENA_URL (default wss://victrisarena.com/bot: a local ladder, or the
// ladder this copy was downloaded from), ARENA_TOKEN,
// ARENA_VERSION (default v1; every game is rated for it) and ARENA_MATCHES (stop after
// this many matches; default: keep playing). It reconnects by itself if the ladder restarts or
// the network drops.
//
// This file is the connection: the protocol, queueing, one turn per observation. The strategy,
// decide(), is in strategy.ts.
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { decide, type Match, type Observation, type Turn } from "./strategy.ts";

/** The reply to an observation. A bug in `decide` costs one idle tick, not the match. */
function reply(obs: Observation, match: Match | null): string {
  let turn: Turn = {};
  try {
    if (match) turn = decide(obs, match);
  } catch (e) {
    console.error(`decide failed on tick ${obs.tick}:`, e);
  }
  return JSON.stringify({ tick: obs.tick, ...turn });
}

const url = process.env.ARENA_URL ?? "wss://victrisarena.com/bot";
const headers = { Authorization: `Bearer ${process.env.ARENA_TOKEN ?? "dev"}` };
// Behind an HTTPS proxy (cloud sandboxes), the WebSocket upgrade must tunnel through it.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const agent = proxy && url.startsWith("wss://") ? new HttpsProxyAgent(proxy) : undefined;
const maxMatches = Number(process.env.ARENA_MATCHES ?? Infinity) || Infinity;
let played = 0;
const version = process.env.ARENA_VERSION ?? "v1";
// Every game is rated for this version; create the next numbered version each time the bot changes.
const queueMessage = JSON.stringify({
  type: "queue",
  version,
  ...(process.env.ARENA_LADDER ? { ladder_id: process.env.ARENA_LADDER } : {}),
});

// The connection survives ladder restarts and network drops: it reconnects with backoff (1 s,
// doubling to 30 s) and queues again. Mid-match, the ladder sends hello then the current
// observation (and answers the queue with a harmless already_queued). The same match_id means
// resume: keep the match's state. Errors that reconnecting can't fix end the bot.
const FATAL = new Set([
  "missing_authorization",
  "invalid_token",
  "suspended",
  "banned",
  "retired",
  "account_banned",
  "account_required",
  "human_only",
  "replaced",
  "unknown_ladder",
  "ladder_closed",
  "enrollment_required",
  "wrong_ladder",
  "membership_revoked",
  "ladder_unavailable",
]);
let delay = 1000;
let done = false;
let match: Match | null = null;

function connect(): void {
  const ws = new WebSocket(url, { headers, agent, handshakeTimeout: 10_000 });
  let fatal = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pongTimeout: ReturnType<typeof setTimeout> | undefined;
  let pendingPing: string | null = null;
  let pingId = 0;
  ws.on("open", () => {
    ws.send(queueMessage);
    // Queue silence is normal. Probe the transport, including on the local runner.
    heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || pendingPing !== null) return;
      pendingPing = String(++pingId);
      pongTimeout = setTimeout(() => {
        console.error("heartbeat timeout: no pong in 20 s");
        ws.terminate(); // Don't wait for a closing handshake over a broken connection.
      }, 20_000);
      ws.ping(pendingPing);
    }, 20_000);
  });
  ws.on("pong", (data) => {
    if (pendingPing === null || data.toString() !== pendingPing) return;
    clearTimeout(pongTimeout);
    pendingPing = null;
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type !== "error") delay = 1000; // a working connection resets the backoff
    if (msg.type === "server_draining") {
      console.error(
        `server restarting: matchmaking paused; drain deadline ${msg.drain_deadline}. Keep playing until close, then reconnect.`,
      );
    } else if (msg.type === "hello") {
      if (match?.id !== msg.match_id) match = { id: msg.match_id, rules: msg.rules, pads: msg.pickups, map: msg.map };
      ws.send(JSON.stringify({ type: "ready" }));
    } else if (msg.type === "observation") ws.send(reply(msg, match));
    else if (msg.type === "end") {
      console.log(
        `${msg.result} (${msg.reason}) rating_change=${msg.rating_change ?? "?"}${msg.watch_url ? ` watch: ${msg.watch_url}` : ""}`,
      );
      match = null;
      if (++played >= maxMatches) {
        done = true; // ARENA_MATCHES reached
        ws.close();
      } else ws.send(queueMessage); // play again
    } else if (msg.type === "error") {
      console.error(`${msg.code}: ${msg.message}`);
      if (FATAL.has(msg.code)) {
        fatal = true;
        ws.close();
      }
    }
  });
  ws.on("error", (e) => console.error(`connection error: ${e.message}`)); // "close" follows
  ws.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(pongTimeout);
    if (done || fatal) return process.exit(fatal ? 1 : 0);
    console.error(`disconnected; reconnecting in ${delay / 1000} s`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  });
}

connect();
