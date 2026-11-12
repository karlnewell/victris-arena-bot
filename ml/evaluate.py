"""Win rates of a trained network in the simulator against the bundled bots and our scripted ones.

    .venv/bin/python evaluate.py models/bc-2600.pt [games]
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
            env = FastVectorEnv(games, opponent=opponent, scripts=[os.path.join(HERE, "sparring.js")], grid="uint8", workers=2)
            r = results(policy, env)
            env.close()
            print(f"{'greedy ' if greedy else 'sampled'} vs {opponent:10} win {np.mean(r == 1):.0%} loss {np.mean(r == -1):.0%} draw {np.mean(r == 0):.0%}", flush=True)
