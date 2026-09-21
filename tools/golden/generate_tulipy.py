#!/usr/bin/env python3
"""
Tertiary golden vectors from **tulipy** (Tulip Indicators) — an *independent* C reference, separate
from TA-Lib. Primarily certifies indicators TA-Lib/pandas-ta lack or that benefit from a second
opinion: the Mesa Sine Wave (`msw`) and the cross utilities (`crossover`/`crossany`), plus a few
cross-checks. Output committed to packages/technical-analysis/test/golden/tulipy-golden.json (CI needs no Python).

Reproduce with: python3 tools/golden/generate_tulipy.py
"""

from __future__ import annotations
import json, math, os, platform
import numpy as np
import tulipy

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "technical-analysis", "test", "golden"))
D = json.load(open(os.path.join(OUT, "reference-ohlcv.json")))

try:
    _v = tulipy.lib.TI_VERSION
    _TI_VERSION = _v.decode() if isinstance(_v, (bytes, bytearray)) else str(_v)
except Exception:
    _TI_VERSION = getattr(tulipy, "__version__", "unknown")
META = {
    "generator": "tools/golden/generate_tulipy.py",
    "reference": "tulipy (Tulip Indicators)",
    "referenceVersion": _TI_VERSION,
    "python": platform.python_version(),
    "packages": {"numpy": np.__version__, "tulipy": _TI_VERSION},
    "dataset": "reference-ohlcv.json",
}
o, h, l, c, v = (np.array(D[k]) for k in ("open", "high", "low", "close", "volume"))
N = len(c)

entries = []


def pad(arr):
    """Left-pad a tulipy output (trimmed by its lookback) to full length with nulls."""
    arr = np.asarray(arr, dtype=float)
    lead = N - len(arr)
    out = [None] * lead + [
        None if (math.isnan(x) or math.isinf(x)) else float(x) for x in arr.tolist()
    ]
    return out


def add(name, params, columns):
    entries.append({"name": name, "params": params, "outputs": {k: pad(s) for k, s in columns.items()}})


sine, lead = tulipy.msw(c, 5)
add("msw", {"period": 5}, {"sine": sine, "lead": lead})

add("crossover", {"inputs": ["close", "open"]}, {"real": tulipy.crossover(c, o)})
add("crossany", {"inputs": ["close", "open"]}, {"real": tulipy.crossany(c, o)})
add("qstick", {"period": 10}, {"real": tulipy.qstick(o, c, 10)})
add("wad", {}, {"real": tulipy.wad(h, l, c)})
add("marketfi", {}, {"real": tulipy.marketfi(h, l, v)})

with open(os.path.join(OUT, "tulipy-golden.json"), "w") as f:
    json.dump({"meta": META, "dataset": "reference-ohlcv.json", "entries": entries}, f)
print(f"wrote tulipy-golden.json ({len(entries)} entries)")
