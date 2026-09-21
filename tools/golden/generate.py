#!/usr/bin/env python3
"""
Golden-vector generator for TotalFinance's TA package.

This is the *certification* tooling: it produces the deterministic reference OHLCV
series and the canonical TA-Lib (C reference) outputs that the TypeScript test
`packages/technical-analysis/test/talib-golden.test.ts` asserts TotalFinance reproduces. It is the
"external source of truth" — none of these numbers come from TotalFinance itself.

Reproduce with (TA-Lib 0.6.x + numpy installed):

    python3 tools/golden/generate.py

Outputs (committed to the repo so CI needs no Python/TA-Lib):
  packages/technical-analysis/test/golden/reference-ohlcv.json   — the input series (single source of truth)
  packages/technical-analysis/test/golden/talib-golden.json      — per-function reference outputs (NaN -> null)
  packages/technical-analysis/test/golden/talib-candles-golden.json — 61 CDL pattern integer outputs
  packages/technical-analysis/test/golden/talib-meta.json        — full 158-function catalog metadata (for the audit)
"""

from __future__ import annotations

import json
import math
import os

import numpy as np
import talib
from talib import abstract

import platform

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "technical-analysis", "test", "golden"))
os.makedirs(OUT, exist_ok=True)

SEED = 20240617
N = 256

# Provenance stamped into every fixture so regenerated vectors are auditable.
META = {
    "generator": "tools/golden/generate.py",
    "reference": "TA-Lib",
    "referenceVersion": talib.__ta_version__.decode().split(" ")[0],
    "python": platform.python_version(),
    "packages": {"numpy": np.__version__, "TA-Lib": talib.__version__},
    "seed": SEED,
    "dataset": "reference-ohlcv.json",
}


def clean(arr):
    """numpy float array -> list with NaN/Inf rendered as null (JSON-safe, JS-comparable)."""
    out = []
    for v in np.asarray(arr, dtype=float).tolist():
        out.append(None if (v is None or math.isnan(v) or math.isinf(v)) else v)
    return out


# ── deterministic OHLCV (geometric random walk with realistic intrabar range) ──
def build_dataset():
    rng = np.random.default_rng(SEED)
    s0 = 100.0
    closes = np.empty(N)
    opens = np.empty(N)
    highs = np.empty(N)
    lows = np.empty(N)
    vols = np.empty(N)
    prev_close = s0
    for i in range(N):
        r = rng.normal(0.0003, 0.013)
        close = prev_close * math.exp(r)
        gap = rng.normal(0.0, 0.0035)
        open_ = (prev_close if i > 0 else s0) * math.exp(gap)
        # half-range as a fraction of price; always positive so high>=max, low<=min
        up = abs(rng.normal(0.0, 0.009)) + 0.0015
        dn = abs(rng.normal(0.0, 0.009)) + 0.0015
        hi = max(open_, close) * (1.0 + up)
        lo = min(open_, close) * (1.0 - dn)
        vol = round(1_000_000 * (1.0 + abs(rng.normal(0.0, 0.45))) + 50_000)
        opens[i] = round(open_, 4)
        closes[i] = round(close, 4)
        highs[i] = round(hi, 4)
        lows[i] = round(lo, 4)
        vols[i] = float(vol)
        prev_close = close
    # re-establish OHLC invariants after rounding
    for i in range(N):
        highs[i] = max(opens[i], highs[i], lows[i], closes[i])
        lows[i] = min(opens[i], highs[i], lows[i], closes[i])
    return opens, highs, lows, closes, vols


opens, highs, lows, closes, vols = build_dataset()

# A bounded series in (0.1, 0.9) — in-domain for every element-wise math transform at once
# (acos/asin need [-1,1], ln/log10/sqrt need > 0), so a single fixture certifies them all.
unit = [round(0.5 + 0.4 * math.sin(i / 5), 6) for i in range(N)]

dataset = {
    "seed": SEED,
    "n": N,
    "open": opens.tolist(),
    "high": highs.tolist(),
    "low": lows.tolist(),
    "close": closes.tolist(),
    "volume": vols.tolist(),
    "unit": unit,
}
dataset["meta"] = META
with open(os.path.join(OUT, "reference-ohlcv.json"), "w") as f:
    json.dump(dataset, f)
print(f"wrote reference-ohlcv.json ({N} bars)")

O, H, L, C, V = opens, highs, lows, closes, vols

# ── catalog metadata (for the completeness audit + docs) ──
meta = {}
for group, fns in talib.get_function_groups().items():
    meta[group] = []
    for fn in fns:
        info = abstract.Function(fn).info
        meta[group].append(
            {
                "name": fn,
                "inputs": info["input_names"],
                "params": info["parameters"],
                "outputs": info["output_names"],
            }
        )
with open(os.path.join(OUT, "talib-meta.json"), "w") as f:
    json.dump(meta, f, indent=0)
print(f"wrote talib-meta.json ({sum(len(v) for v in meta.values())} functions)")

# ── reference outputs ──
# Each entry: { "fn", "group", "params", "outputs": { outName: [...] } }
# We sweep a few parameter sets for period-driven functions to exercise warmup + value paths.
PERIODS = [5, 14, 30]

entries = []


def add(fn, params, out):
    """`out` is a numpy array or tuple-of-arrays; map to named outputs from TA-Lib metadata."""
    info = abstract.Function(fn).info
    names = info["output_names"]
    if isinstance(out, tuple):
        outputs = {names[i]: clean(out[i]) for i in range(len(names))}
    else:
        outputs = {names[0]: clean(out)}
    entries.append(
        {"fn": fn, "group": info["group"], "params": params, "outputs": outputs}
    )


# Overlap studies ----------------------------------------------------------------
for p in PERIODS:
    add("SMA", {"timeperiod": p}, talib.SMA(C, timeperiod=p))
    add("EMA", {"timeperiod": p}, talib.EMA(C, timeperiod=p))
    add("WMA", {"timeperiod": p}, talib.WMA(C, timeperiod=p))
    add("DEMA", {"timeperiod": p}, talib.DEMA(C, timeperiod=p))
    add("TEMA", {"timeperiod": p}, talib.TEMA(C, timeperiod=p))
    add("TRIMA", {"timeperiod": p}, talib.TRIMA(C, timeperiod=p))
    add("KAMA", {"timeperiod": p}, talib.KAMA(C, timeperiod=p))
    add("MIDPOINT", {"timeperiod": p}, talib.MIDPOINT(C, timeperiod=p))
    add("MIDPRICE", {"timeperiod": p}, talib.MIDPRICE(H, L, timeperiod=p))
add("T3", {"timeperiod": 5, "vfactor": 0.7}, talib.T3(C, timeperiod=5, vfactor=0.7))
add("HT_TRENDLINE", {}, talib.HT_TRENDLINE(C))
add("SAR", {"acceleration": 0.02, "maximum": 0.2}, talib.SAR(H, L, acceleration=0.02, maximum=0.2))
add("MAMA", {"fastlimit": 0.5, "slowlimit": 0.05}, talib.MAMA(C, fastlimit=0.5, slowlimit=0.05))
# MA matype sweep: 0 SMA,1 EMA,2 WMA,3 DEMA,4 TEMA,5 TRIMA,6 KAMA,8 T3
for mt in [0, 1, 2, 3, 4, 5, 6, 8]:
    add("MA", {"timeperiod": 14, "matype": mt}, talib.MA(C, timeperiod=14, matype=mt))
for nb in [2.0, 2.5]:
    add(
        "BBANDS",
        {"timeperiod": 20, "nbdevup": nb, "nbdevdn": nb, "matype": 0},
        talib.BBANDS(C, timeperiod=20, nbdevup=nb, nbdevdn=nb, matype=0),
    )
# MAVP: moving average with a per-bar variable period. The `periods` array is committed in the
# entry params so the TypeScript test feeds TotalFinance the identical period series.
mavp_periods = [float(2 + (i * 7) % 29) for i in range(N)]  # varies 2..30
add(
    "MAVP",
    {"periods": mavp_periods, "minperiod": 2, "maxperiod": 30, "matype": 0},
    talib.MAVP(C, np.array(mavp_periods), minperiod=2, maxperiod=30, matype=0),
)

# Momentum -----------------------------------------------------------------------
for p in PERIODS:
    add("RSI", {"timeperiod": p}, talib.RSI(C, timeperiod=p))
    add("ROC", {"timeperiod": p}, talib.ROC(C, timeperiod=p))
    add("ROCP", {"timeperiod": p}, talib.ROCP(C, timeperiod=p))
    add("ROCR", {"timeperiod": p}, talib.ROCR(C, timeperiod=p))
    add("ROCR100", {"timeperiod": p}, talib.ROCR100(C, timeperiod=p))
    add("MOM", {"timeperiod": p}, talib.MOM(C, timeperiod=p))
    add("CMO", {"timeperiod": p}, talib.CMO(C, timeperiod=p))
    add("CCI", {"timeperiod": p}, talib.CCI(H, L, C, timeperiod=p))
    add("WILLR", {"timeperiod": p}, talib.WILLR(H, L, C, timeperiod=p))
    add("ADX", {"timeperiod": p}, talib.ADX(H, L, C, timeperiod=p))
    add("ADXR", {"timeperiod": p}, talib.ADXR(H, L, C, timeperiod=p))
    add("DX", {"timeperiod": p}, talib.DX(H, L, C, timeperiod=p))
    add("MINUS_DI", {"timeperiod": p}, talib.MINUS_DI(H, L, C, timeperiod=p))
    add("PLUS_DI", {"timeperiod": p}, talib.PLUS_DI(H, L, C, timeperiod=p))
    add("MINUS_DM", {"timeperiod": p}, talib.MINUS_DM(H, L, timeperiod=p))
    add("PLUS_DM", {"timeperiod": p}, talib.PLUS_DM(H, L, timeperiod=p))
    add("MFI", {"timeperiod": p}, talib.MFI(H, L, C, V, timeperiod=p))
    add("AROONOSC", {"timeperiod": p}, talib.AROONOSC(H, L, timeperiod=p))
    add("AROON", {"timeperiod": p}, talib.AROON(H, L, timeperiod=p))
    add("TRIX", {"timeperiod": p}, talib.TRIX(C, timeperiod=p))
add("BOP", {}, talib.BOP(O, H, L, C))
# APO/PPO: matype 0 (SMA, TA-Lib default) AND matype 1 (EMA, TradingView/TotalFinance default).
add("APO", {"fastperiod": 12, "slowperiod": 26, "matype": 0}, talib.APO(C, fastperiod=12, slowperiod=26, matype=0))
add("APO", {"fastperiod": 12, "slowperiod": 26, "matype": 1}, talib.APO(C, fastperiod=12, slowperiod=26, matype=1))
add("PPO", {"fastperiod": 12, "slowperiod": 26, "matype": 0}, talib.PPO(C, fastperiod=12, slowperiod=26, matype=0))
add("PPO", {"fastperiod": 12, "slowperiod": 26, "matype": 1}, talib.PPO(C, fastperiod=12, slowperiod=26, matype=1))
add("MACD", {"fastperiod": 12, "slowperiod": 26, "signalperiod": 9}, talib.MACD(C, fastperiod=12, slowperiod=26, signalperiod=9))
add("MACDFIX", {"signalperiod": 9}, talib.MACDFIX(C, signalperiod=9))
add("STOCH", {"fastk_period": 14, "slowk_period": 3, "slowk_matype": 0, "slowd_period": 3, "slowd_matype": 0},
    talib.STOCH(H, L, C, fastk_period=14, slowk_period=3, slowk_matype=0, slowd_period=3, slowd_matype=0))
add("STOCHF", {"fastk_period": 14, "fastd_period": 3, "fastd_matype": 0},
    talib.STOCHF(H, L, C, fastk_period=14, fastd_period=3, fastd_matype=0))
add("STOCHRSI", {"timeperiod": 14, "fastk_period": 5, "fastd_period": 3, "fastd_matype": 0},
    talib.STOCHRSI(C, timeperiod=14, fastk_period=5, fastd_period=3, fastd_matype=0))
add("ULTOSC", {"timeperiod1": 7, "timeperiod2": 14, "timeperiod3": 28},
    talib.ULTOSC(H, L, C, timeperiod1=7, timeperiod2=14, timeperiod3=28))

# Volume -------------------------------------------------------------------------
add("OBV", {}, talib.OBV(C, V))
add("AD", {}, talib.AD(H, L, C, V))
add("ADOSC", {"fastperiod": 3, "slowperiod": 10}, talib.ADOSC(H, L, C, V, fastperiod=3, slowperiod=10))

# Volatility ---------------------------------------------------------------------
for p in PERIODS:
    add("ATR", {"timeperiod": p}, talib.ATR(H, L, C, timeperiod=p))
    add("NATR", {"timeperiod": p}, talib.NATR(H, L, C, timeperiod=p))
add("TRANGE", {}, talib.TRANGE(H, L, C))

# Price transform ----------------------------------------------------------------
add("AVGPRICE", {}, talib.AVGPRICE(O, H, L, C))
add("MEDPRICE", {}, talib.MEDPRICE(H, L))
add("TYPPRICE", {}, talib.TYPPRICE(H, L, C))
add("WCLPRICE", {}, talib.WCLPRICE(H, L, C))

# Cycle (Hilbert transform) ------------------------------------------------------
add("HT_DCPERIOD", {}, talib.HT_DCPERIOD(C))
add("HT_DCPHASE", {}, talib.HT_DCPHASE(C))
add("HT_PHASOR", {}, talib.HT_PHASOR(C))
add("HT_SINE", {}, talib.HT_SINE(C))
add("HT_TRENDMODE", {}, talib.HT_TRENDMODE(C))

# Statistic functions ------------------------------------------------------------
for p in PERIODS:
    add("LINEARREG", {"timeperiod": p}, talib.LINEARREG(C, timeperiod=p))
    add("LINEARREG_SLOPE", {"timeperiod": p}, talib.LINEARREG_SLOPE(C, timeperiod=p))
    add("LINEARREG_INTERCEPT", {"timeperiod": p}, talib.LINEARREG_INTERCEPT(C, timeperiod=p))
    add("LINEARREG_ANGLE", {"timeperiod": p}, talib.LINEARREG_ANGLE(C, timeperiod=p))
    add("TSF", {"timeperiod": p}, talib.TSF(C, timeperiod=p))
    add("CORREL", {"timeperiod": p}, talib.CORREL(H, L, timeperiod=p))
    add("BETA", {"timeperiod": p}, talib.BETA(H, L, timeperiod=p))
    add("STDDEV", {"timeperiod": p, "nbdev": 1.0}, talib.STDDEV(C, timeperiod=p, nbdev=1.0))
    add("VAR", {"timeperiod": p, "nbdev": 1.0}, talib.VAR(C, timeperiod=p, nbdev=1.0))

# Math operators (windowed) ------------------------------------------------------
for p in [10, 30]:
    add("MAX", {"timeperiod": p}, talib.MAX(C, timeperiod=p))
    add("MIN", {"timeperiod": p}, talib.MIN(C, timeperiod=p))
    add("SUM", {"timeperiod": p}, talib.SUM(C, timeperiod=p))
    add("MAXINDEX", {"timeperiod": p}, talib.MAXINDEX(C, timeperiod=p))
    add("MININDEX", {"timeperiod": p}, talib.MININDEX(C, timeperiod=p))
    add("MINMAX", {"timeperiod": p}, talib.MINMAX(C, timeperiod=p))
    add("MINMAXINDEX", {"timeperiod": p}, talib.MINMAXINDEX(C, timeperiod=p))

# Math transforms (element-wise) on the in-domain unit series ----------------------
U = np.array(unit)
for fn in ["ACOS", "ASIN", "ATAN", "CEIL", "COS", "COSH", "EXP", "FLOOR", "LN", "LOG10", "SIN", "SINH", "SQRT", "TAN", "TANH"]:
    add(fn, {"input": "unit"}, getattr(talib, fn)(U))
# Math operators (element-wise, two series) on high/low ------------------------------
for fn in ["ADD", "SUB", "MULT", "DIV"]:
    add(fn, {"inputs": ["high", "low"]}, getattr(talib, fn)(H, L))

with open(os.path.join(OUT, "talib-golden.json"), "w") as f:
    json.dump({"meta": META, "dataset": "reference-ohlcv.json", "entries": entries}, f)
print(f"wrote talib-golden.json ({len(entries)} entries)")

# ── candlesticks: every CDL function, default params ──
candles = {}
for fn in talib.get_function_groups()["Pattern Recognition"]:
    candles[fn] = [int(x) for x in talib.abstract.Function(fn)(
        {"open": O, "high": H, "low": L, "close": C, "volume": V}
    ).tolist()]
with open(os.path.join(OUT, "talib-candles-golden.json"), "w") as f:
    json.dump({"meta": META, "patterns": candles}, f)
print(f"wrote talib-candles-golden.json ({len(candles)} patterns)")

# quick non-null coverage report
nonnull = sum(
    1 for e in entries for arr in e["outputs"].values() if any(v is not None for v in arr)
)
print(f"entries with at least one non-null output: {nonnull}/{sum(len(e['outputs']) for e in entries)} output series")
