#!/usr/bin/env python3
"""
Secondary golden vectors from pandas-ta — for the *modern* indicators TA-Lib does not have
(supertrend, vortex, choppiness, …). pandas-ta is the de-facto Python reference for these, and
TotalFinance follows the same (TradingView/pandas-ta) conventions. Output is committed so CI needs no
Python: packages/technical-analysis/test/golden/pandas-ta-golden.json.

Reproduce with: python3 tools/golden/generate_pandas_ta.py
"""

from __future__ import annotations
import json, math, os, platform
import numpy as np, pandas as pd, pandas_ta as pta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "technical-analysis", "test", "golden"))
D = json.load(open(os.path.join(OUT, "reference-ohlcv.json")))

META = {
    "generator": "tools/golden/generate_pandas_ta.py",
    "reference": "pandas-ta",
    "referenceVersion": str(pta.version),
    "python": platform.python_version(),
    "packages": {"numpy": np.__version__, "pandas": pd.__version__, "pandas-ta": str(pta.version)},
    "dataset": "reference-ohlcv.json",
}
df = pd.DataFrame({k: D[k] for k in ["open", "high", "low", "close", "volume"]})
h, l, c, o, v = df.high, df.low, df.close, df.open, df.volume


def clean(series):
    arr = np.asarray(series, dtype=float).ravel()  # handles Series and 1-column DataFrame
    return [None if (math.isnan(x) or math.isinf(x)) else float(x) for x in arr]


entries = []


def add(name, params, columns):
    # columns: dict logicalName -> pandas Series
    entries.append(
        {"name": name, "params": params, "outputs": {k: clean(s) for k, s in columns.items()}}
    )


ao = pta.ao(h, l, fast=5, slow=34)
add("ao", {"fast": 5, "slow": 34}, {"real": ao})
add("cmf", {"length": 20}, {"real": pta.cmf(h, l, c, v, length=20)})
add("chop", {"length": 14}, {"real": pta.chop(h, l, c, length=14)})
add("bias", {"length": 26}, {"real": pta.bias(c, length=26)})
add("coppock", {"length": 10, "fast": 11, "slow": 14}, {"real": pta.coppock(c, length=10, fast=11, slow=14)})
add("pgo", {"length": 14}, {"real": pta.pgo(h, l, c, length=14)})
add("cti", {"length": 12}, {"real": pta.cti(c, length=12)})
add("massi", {"fast": 9, "slow": 25}, {"real": pta.massi(h, l, fast=9, slow=25)})

vtx = pta.vortex(h, l, c, length=14)
add("vortex", {"length": 14}, {"plus": vtx["VTXP_14"], "minus": vtx["VTXM_14"]})

st = pta.supertrend(h, l, c, length=7, multiplier=3.0)
add("supertrend", {"length": 7, "multiplier": 3.0}, {"line": st["SUPERT_7_3.0"], "dir": st["SUPERTd_7_3.0"]})

tsi = pta.tsi(c, fast=13, slow=25, signal=13)
add("tsi", {"fast": 13, "slow": 25, "signal": 13}, {"real": tsi["TSI_13_25_13"], "signal": tsi["TSIs_13_25_13"]})

add("efi", {"length": 13}, {"real": pta.efi(c, v, length=13)})
add("nvi", {}, {"real": pta.nvi(c, v)})
add("pvi", {}, {"real": pta.pvi(c, v)})

# ── newly-added parity indicators ──
add("psl", {"length": 12}, {"real": pta.psl(c, length=12)})
add("vhf", {"length": 28}, {"real": pta.vhf(c, length=28)})
# TotalFinance's EBSW matches pandas-ta's original formula (the 0.4.x default rewrote it).
add("ebsw", {"length": 40, "bars": 10}, {"real": pta.ebsw(c, length=40, bars=10, initial_version=True)})

# pandas-ta's cdl_z uses a population std regardless of `ddof`, so it matches TotalFinance's `ddof: 0`
# (the test compares against ddof 0); we record ddof=0 here to keep the metadata honest.
cdlz = pta.cdl_z(o, h, l, c, length=30, ddof=0)
add("cdl_z", {"length": 30, "ddof": 0}, {
    "open": cdlz["open_Z_30_0"], "high": cdlz["high_Z_30_0"],
    "low": cdlz["low_Z_30_0"], "close": cdlz["close_Z_30_0"],
})

dd = pta.drawdown(c)
add("drawdown", {}, {"drawdown": dd["DD"], "percent": dd["DD_PCT"], "log": dd["DD_LOG"]})

amat = pta.amat(c, fast=8, slow=21, lookback=2, mamode="ema")
add("amat", {"fast": 8, "slow": 21, "lookback": 2}, {
    "long": amat["AMATe_LR_8_21_2"], "short": amat["AMATe_SR_8_21_2"],
})

# ── moving-average family ──
add("alma", {"length": 10, "sigma": 6.0, "offset": 0.85}, {"real": pta.alma(c, length=10, sigma=6.0, distribution_offset=0.85)})
add("fwma", {"length": 10}, {"real": pta.fwma(c, length=10)})
add("hma", {"length": 10}, {"real": pta.hma(c, length=10)})
add("pwma", {"length": 10}, {"real": pta.pwma(c, length=10)})
add("sinwma", {"length": 14}, {"real": pta.sinwma(c, length=14)})
add("swma", {"length": 10}, {"real": pta.swma(c, length=10)})
add("vwma", {"length": 10}, {"real": pta.vwma(c, v, length=10)})
add("zlma", {"length": 10}, {"real": pta.zlma(c, length=10, mamode="ema")})
add("rma", {"length": 10}, {"real": pta.rma(c, length=10)})

# ── rolling statistics ──
add("zscore", {"length": 30, "std": 1}, {"real": pta.zscore(c, length=30, std=1)})
add("mad", {"length": 30}, {"real": pta.mad(c, length=30)})
add("skew", {"length": 30}, {"real": pta.skew(c, length=30)})
add("kurtosis", {"length": 30}, {"real": pta.kurtosis(c, length=30)})
add("median", {"length": 30}, {"real": pta.median(c, length=30)})

# ── volatility / volume singles ──
add("ui", {"length": 14}, {"real": pta.ui(c, length=14)})
add("pdist", {}, {"real": pta.pdist(o, h, l, c)})

with open(os.path.join(OUT, "pandas-ta-golden.json"), "w") as f:
    json.dump({"meta": META, "dataset": "reference-ohlcv.json", "entries": entries}, f)
print(f"wrote pandas-ta-golden.json ({len(entries)} entries)")
