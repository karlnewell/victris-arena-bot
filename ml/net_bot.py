"""Victris Arena starter bot (Python). Same strategy as bots/ts-starter: every turn has two phases,
movement then attack. Movement dodges what the observation says will hit us, keeps inside the
shrinking zone, grabs nearby pickups, closes in, and searches when the enemy is out of sight; the
attack then fires from wherever the movement ends. Every number comes from hello["rules"], so the
bot keeps working when the ladder retunes them. A turn is a dict with optional "move" (a
direction), "dash" (a direction) and "attack" ({"name": ..., "target": [x, y]}).

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    ARENA_TOKEN=<your token> .venv/bin/python bot.py

(A virtualenv, because many systems refuse a global pip install. The arena CLI's
check-bot, check-protocol and run use a bot directory's .venv automatically.)

Environment: ARENA_URL (default wss://victrisarena.com/bot: a local ladder, or the
ladder this copy was downloaded from), ARENA_TOKEN,
ARENA_VERSION (default v1; every game is rated for it) and ARENA_MATCHES (stop after
this many matches; default: keep playing). It reconnects by itself if the ladder restarts or the
network drops.

Every observation field: /docs/schema/observation.json. Every rule: /docs/rules.
"""
import asyncio
import inspect
import json
import os
import traceback

import websockets

# How close the bot likes to fight: a choice of strategy, not a rule of the game.
FIGHTING_RANGE = 5
# Ticks spent heading for each corner of the patrol while searching, and how far it is from the centre.
PATROL_TICKS = 30
PATROL_RADIUS = 2


# --- The policy: a network trained from ladder replays (see ml/README.md) -----------------------
import numpy as np
from arena_sim import Basic
from arena_sim.examples.train_ppo_gpu import load

MODEL = os.environ.get("ARENA_MODEL", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "current.pt"))
ENCODER = Basic()
POLICY = load(MODEL, "cpu")


def decide(obs, match):
    """Encode the observation as the network reads it, take its best legal action, decode it to a turn."""
    if obs["self"]["state"] != "idle":
        return {}
    hello = match["hello"]
    encoded = ENCODER.encode(obs, hello)
    mask = ENCODER.action_mask(obs, hello)
    action = POLICY({k: v[None] for k, v in encoded.items()}, mask[None])[0]
    return ENCODER.decode(action, obs, hello)


def reply(obs, match):
    """The reply to an observation. A bug in decide costs one idle tick, not the match."""
    turn = {}
    try:
        if match:
            turn = decide(obs, match)
    except Exception:
        print(f"decide failed on tick {obs['tick']}:", flush=True)
        traceback.print_exc()
    return json.dumps({"tick": obs["tick"], **turn})


# Errors that reconnecting can't fix: the bot stops.
FATAL = {"missing_authorization", "invalid_token", "suspended", "banned", "retired", "account_banned", "account_required", "human_only", "replaced", "unknown_ladder", "ladder_closed", "enrollment_required", "wrong_ladder", "membership_revoked", "ladder_unavailable"}


async def play(url, headers, queue, state):
    """One connection: queue, then answer the ladder until it closes. Returns True when the bot is done."""
    # Probe the transport even while queued; JSON messages can legitimately be silent.
    keepalive = {"open_timeout": 10, "ping_interval": 20, "ping_timeout": 20, "close_timeout": 5}
    # The header keyword changed in websockets 14; older versions fail only when awaited.
    header_key = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
    conn = websockets.connect(url, **{header_key: headers}, **keepalive)
    async with conn as ws:
        await ws.send(queue)
        async for raw in ws:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind != "error":
                state["delay"] = 1  # a working connection resets the backoff
            if kind == "server_draining":
                print(f"server restarting: matchmaking paused; drain deadline {msg['drain_deadline']}. Keep playing until close, then reconnect.", flush=True)
            elif kind == "hello":
                # The same match_id resumes a match; keep any state we retained.
                if state["match"] is None or state["match"]["id"] != msg["match_id"]:
                    state["match"] = {"id": msg["match_id"], "rules": msg["rules"], "hello": msg}
                await ws.send(json.dumps({"type": "ready"}))
            elif kind == "observation":
                await ws.send(reply(msg, state["match"]))
            elif kind == "end":
                print(f"{msg['result']} ({msg['reason']}) rating_change={msg.get('rating_change')} watch: {msg.get('watch_url', '')}", flush=True)
                state["match"] = None
                state["played"] += 1
                if state["played"] >= state["max_matches"]:  # ARENA_MATCHES reached
                    return True
                await ws.send(queue)
            elif kind == "error":
                print(f"{msg['code']}: {msg['message']}", flush=True)
                if msg["code"] in FATAL:
                    return True
    return False


async def main():
    url = os.environ.get("ARENA_URL", "wss://victrisarena.com/bot")
    token = os.environ.get("ARENA_TOKEN", "dev")
    headers = {"Authorization": f"Bearer {token}"}
    version = os.environ.get("ARENA_VERSION", "v1")
    # Every game is rated for this version; create the next numbered version each time the bot changes.
    q = {"type": "queue", "version": version}
    if os.environ.get("ARENA_LADDER"):
        q["ladder_id"] = os.environ["ARENA_LADDER"]
    state = {"played": 0, "max_matches": int(os.environ.get("ARENA_MATCHES", "0")) or float("inf"), "delay": 1, "match": None}
    # The connection survives ladder restarts and network drops: reconnect with backoff (1 s,
    # doubling to 30 s) and queue again. Mid-match, the ladder sends hello then the current
    # observation (and answers the queue with a harmless already_queued). Keep state for the same match_id.
    while True:
        try:
            if await play(url, headers, json.dumps(q), state):
                return
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as e:
            print(f"connection lost: {e}", flush=True)
        print(f"reconnecting in {state['delay']} s", flush=True)
        await asyncio.sleep(state["delay"])
        state["delay"] = min(state["delay"] * 2, 30)


if __name__ == "__main__":
    asyncio.run(main())
