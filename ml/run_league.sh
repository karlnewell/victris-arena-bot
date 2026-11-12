#!/usr/bin/env bash
# Usage: ./run_league.sh <init.pt> <out-dir> <minutes>   (run inside screen/tmux to survive logout)
# BOTS overrides the opponent pool; the "n" names are the randomised bots from sparring.ts.
cd "$(dirname "$0")"
BOTS=${BOTS:-"random ts-starter v3n v2n v1n rushern startern closen farn v3 close far"}
exec uv run python -u -m arena_sim.examples.league --init "$1" --out "$2" \
  --bots $BOTS --scripts sparring.js --minutes "$3" --workers 32
