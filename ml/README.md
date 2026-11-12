# Learned policy (stage 1: imitation)

Trains a network to imitate the ladder's strongest bots from their public replays, then plays it.
Nothing here has produced a trained model yet: the first download was stopped part-way.

## Setup (Python 3.11+, [uv](https://docs.astral.sh/uv/))

```bash
cd ml
uv sync
```

Dependencies are in `pyproject.toml` and pinned in `uv.lock`. PyTorch comes from the CPU-only
index; for a GPU host, change the `pytorch-cpu` index URL in `pyproject.toml` (for example to
`https://download.pytorch.org/whl/cu128`) and run `uv lock`.

## 1. Download replays and train

```bash
uv run imitate.py --ladder https://victrisarena.com --min-rating 2600 --limit 150 \
  --cache replays --out models/bc-2600 --epochs 8 --eval-games 256
```

`imitate.py` wraps the simulator package's example and waits out the ladder's temporary 503s.
The ladder throttles replay reads to roughly 30 a minute, so about 1,800 replays takes around an
hour; `--cache` makes a re-run fetch only what is missing.

## 2. Evaluate in the simulator

```bash
(cd .. && npm install && npx esbuild ml/sparring.ts --bundle --format=iife --outfile=ml/sparring.js)
uv run evaluate.py models/bc-2600.pt 256
```

Reports win rates against Random, the starter, and our scripted bots (rusher, v1, v3).

## 3. Play it on the ladder

```bash
cp models/bc-2600.pt models/current.pt
ARENA_VERSION=v4 ARENA_MATCHES=10 uv run --env-file ../.env net_bot.py
```

`net_bot.py` is the Python starter's connection with `decide` replaced by the network.
The token comes from the repository's `.env` (see `../.env.example`); variables given on the
command line override it. It has not been run against the ladder yet.
