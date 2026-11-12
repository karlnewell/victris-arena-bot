"""Win rates of a trained network in the simulator.

Plays the bundled bots and our scripted ones.

uv run evaluate.py models/bc-2600.pt [games]
"""

import os
import sys

import numpy as np
from arena_sim import FastVectorEnv
from arena_sim.examples.train_ppo_gpu import load

HERE = os.path.dirname(os.path.abspath(__file__))


def results(policy, env, seed=0):
    obs, info = env.reset(seed=seed)
    out = np.full(env.num_envs, 2)
    while (out == 2).any():
        obs, _, terminated, _, info = env.step(policy(obs, info["action_mask"]))
        for i in np.flatnonzero(terminated & (out == 2)):
            out[i] = info["result"][i]
    return out


if __name__ == "__main__":
    path = sys.argv[1]
    games = int(sys.argv[2]) if len(sys.argv) > 2 else 256
    for greedy in (True, False):
        policy = load(path)
        policy.greedy = greedy
        for opponent in ("random", "ts-starter", "rusher", "v1", "v3"):
            env = FastVectorEnv(
                games,
                opponent=opponent,
                scripts=[os.path.join(HERE, "sparring.js")],
                grid="uint8",
                workers=2,
            )
            r = results(policy, env)
            env.close()
            mode = "greedy " if greedy else "sampled"
            w, lo, d = (np.mean(r == x) for x in (1, -1, 0))
            print(
                f"{mode} vs {opponent:10} win {w:.0%} loss {lo:.0%} draw {d:.0%}",
                flush=True,
            )
