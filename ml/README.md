# Learned policy

Trains a network to play by reinforcement learning in the simulator, then plays it on the ladder.

The network plays thousands of simulated games at once against a pool of opponents (the bundled
bots, our scripted bots, frozen copies of itself, and itself) and is adjusted toward whatever
scored better. This is the simulator package's `league` example (PPO).

## Setup (Python 3.11+, [uv](https://docs.astral.sh/uv/))

```bash
cd ml
uv sync
(cd .. && npm install && npm run sparring)   # builds sparring.js, the scripted opponents
```

Dependencies are in `pyproject.toml` and pinned in `uv.lock`. PyTorch comes from the CPU-only
index; for a GPU host, change the `pytorch-cpu` index URL in `pyproject.toml` (for example to
`https://download.pytorch.org/whl/cu128`) and run `uv lock`.

## Opponents (`sparring.ts`)

`npm run sparring` registers our scripted bots in the simulator: `v3`, `v2`, `v1`, `rusher`,
`starter`, and two spacing variants generated from `strategy.ts`, `close` and `far`.

Each also has a randomised version with an `n` suffix (`v3n`, `farn`, ...). A scripted bot with
no randomness plays the same game from the same start, so a network can memorise one winning
sequence per map. The randomised versions take occasional random steps, hold fire, and aim beside
the target, so every game differs. Train against the `n` versions.

## Train

On this host (CPU), inside `screen` or `tmux` so it survives logout:

```bash
./run_league.sh <init.pt> models/<name> <minutes> > <name>.log 2>&1
```

Networks are saved to `models/<name>/last.pt` at every check. `best.pt` is the one with the best
worst-case score in the periodic test games, which stops updating once a check scores 100%
against every opponent; prefer `last.pt`.

On NRP Nautilus (GPU), see `k8s/`:

- `league-job.yaml`: the training Job and its 1 GB volume. Needs the opponents as a ConfigMap:
  `kubectl -n i2-llm create configmap victris-sparring --from-file=sparring.js=sparring.js`
- `fetch-pod.yaml`: a short-lived pod to copy networks off the volume afterwards.
- `gpu-util-test-job.yaml`: measures GPU utilization and speed for several trainer settings.
- `gpu-test-job.yaml`: a two-minute check that a GPU, outbound internet and the trainer work.

NRP expects GPU utilization above 40%. The simulator runs on CPU, so the GPU waits on it:
width 256 measured about 30%. Width 1024 measured 57% on an RTX 2080 Ti but 26% on a faster
Tesla V100, so the Job requires an older GPU model. It logs a 10-minute utilization average.

## Evaluate in the simulator

```bash
uv run evaluate.py models/<name>/last.pt 512
```

Trust the `sampled` rows. In the `greedy` rows the network and a non-randomised scripted bot
are both deterministic, so the games repeat: 512 games are about six distinct ones.

Simulator results only show the network beats its own pool. A network that beat `v3` in 77% of
sampled games rated the same as `v3` on the ladder.

## Play on the ladder

```bash
cp models/<name>/last.pt models/current.pt
ARENA_VERSION=v5 ARENA_MATCHES=30 uv run --env-file ../.env python -u net_bot.py
```

`net_bot.py` is the Python starter's connection with `decide` replaced by the network. The token
comes from the repository's `.env` (see `../.env.example`); variables given on the command line
override it. A version needs 30 rated games to be ranked.

## Imitation (not used)

`imitate.py` trains a network to copy the ladder's top bots from their public replays. It reached
64% agreement with them but lost every game to the Starter: most of that agreement was predicting
"do nothing", the most common recorded action. Kept for reference.
