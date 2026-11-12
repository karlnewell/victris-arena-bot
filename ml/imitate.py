"""Imitation learning from ladder replays: the simulator package's example, with polite retries.

    .venv/bin/python imitate.py --ladder https://victrisarena.com --min-rating 2600 --limit 150 \
        --cache replays --out models/bc-2600

The bundled downloader gives up on the first temporary 503. This wraps its HTTP fetch to wait the
server's Retry-After (and pause briefly between requests), then runs the example unchanged.
"""
import time
import urllib.error

from arena_sim import _data
from arena_sim.examples import imitate

_get = _data._get
PAUSE_S = 0.05


def polite_get(url: str) -> bytes:
    for attempt in range(8):
        try:
            data = _get(url)
            time.sleep(PAUSE_S)
            return data
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or attempt == 7:
                raise
            wait = min(120.0, float(e.headers.get("Retry-After") or 0) or 2.0 * 2**attempt)
            print(f"{e.code} from the ladder; waiting {wait:.0f}s", flush=True)
            time.sleep(wait)
    raise RuntimeError("unreachable")


_data._get = polite_get

if __name__ == "__main__":
    imitate.main()
