#!/usr/bin/env python3
"""
Extended golden vectors from pandas-ta for the *long-tail* indicators that TotalFinance ships but had
only name-resolution coverage (no external numerical proof). This is the companion to
generate_pandas_ta.py — same dataset, same conventions — but it targets the second wave of
indicators (aberration, kdj, qqe, squeeze, stc, …). Output is committed so CI needs no Python:
packages/technical-analysis/test/golden/pandas-ta-ext-golden.json.

Each entry records the EXACT pandas-ta call params so the TS assertions can mirror them, and outputs
are keyed by stable logical names (not pandas' length-stamped column names) so the test never depends
on pandas' column-naming scheme.

Reproduce with: python3 tools/golden/generate_pandas_ta_ext.py
"""

from __future__ import annotations
import json, math, os, platform
import numpy as np, pandas as pd, pandas_ta as pta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "technical-analysis", "test", "golden"))
D = json.load(open(os.path.join(OUT, "reference-ohlcv.json")))

META = {
    "generator": "tools/golden/generate_pandas_ta_ext.py",
    "reference": "pandas-ta",
    "referenceVersion": str(pta.version),
    "python": platform.python_version(),
    "packages": {"numpy": np.__version__, "pandas": pd.__version__, "pandas-ta": str(pta.version)},
    "dataset": "reference-ohlcv.json",
    "note": "long-tail indicators (companion to pandas-ta-golden.json)",
}
df = pd.DataFrame({k: D[k] for k in ["open", "high", "low", "close", "volume"]})
h, l, c, o, v = df.high, df.low, df.close, df.open, df.volume


def clean(series):
    arr = np.asarray(series, dtype=float).ravel()
    return [None if (math.isnan(x) or math.isinf(x)) else float(x) for x in arr]


entries = []


def add(name, params, columns):
    entries.append(
        {"name": name, "params": params, "outputs": {k: clean(s) for k, s in columns.items()}}
    )


def C(frame, col):
    """Pick one column out of a pandas-ta DataFrame result."""
    return frame[col]


# ───────────────────────── single-output, close-input ─────────────────────────
add("cfo", {"length": 9}, {"real": pta.cfo(c, length=9)})
add("cg", {"length": 10}, {"real": pta.cg(c, length=10)})
add("decay", {"length": 5, "mode": "linear"}, {"real": pta.decay(c, length=5)})
add("edecay", {"length": 5, "mode": "exp"}, {"real": pta.decay(c, length=5, mode="exp")})
add("decreasing", {"length": 3}, {"real": pta.decreasing(c, length=3)})
add("increasing", {"length": 3}, {"real": pta.increasing(c, length=3)})
add("dpo", {"length": 20, "centered": False}, {"real": pta.dpo(c, length=20, centered=False)})
add("entropy", {"length": 10, "base": 2.0}, {"real": pta.entropy(c, length=10)})
add("er", {"length": 10}, {"real": pta.er(c, length=10)})
add("hwma", {"na": 0.2, "nb": 0.1, "nc": 0.1}, {"real": pta.hwma(c, na=0.2, nb=0.1, nc=0.1)})
add("jma", {"length": 7, "phase": 0}, {"real": pta.jma(c, length=7, phase=0)})
add("log_return", {}, {"real": pta.log_return(c)})
add("percent_return", {}, {"real": pta.percent_return(c)})
add("mcgd", {"length": 10, "c": 1.0}, {"real": pta.mcgd(c, length=10)})
add("quantile", {"length": 30, "q": 0.5}, {"real": pta.quantile(c, length=30, q=0.5)})
add("rsx", {"length": 14}, {"real": pta.rsx(c, length=14)})
add("slope", {"length": 5}, {"real": pta.slope(c, length=5)})
add("ssf", {"length": 10, "poles": 2}, {"real": pta.ssf(c, length=10, poles=2)})
add("ssf3", {"length": 10, "poles": 3}, {"real": pta.ssf(c, length=10, poles=3)})
add("vidya", {"length": 14}, {"real": pta.vidya(c, length=14)})

# ───────────────────────── multi-output, close-input ─────────────────────────
stoch_rsi = pta.stochrsi(c, length=14, rsi_length=14, k=3, d=3)
add("stochrsi", {"length": 14, "rsi_length": 14, "k": 3, "d": 3},
    {"k": C(stoch_rsi, "STOCHRSIk_14_14_3_3"), "d": C(stoch_rsi, "STOCHRSId_14_14_3_3")})

stc = pta.stc(c, tclength=10, fast=12, slow=26, factor=0.5)
add("stc", {"tclength": 10, "fast": 12, "slow": 26, "factor": 0.5},
    {"stc": C(stc, "STC_10_12_26_0.5"), "macd": C(stc, "STCmacd_10_12_26_0.5"),
     "stoch": C(stc, "STCstoch_10_12_26_0.5")})

kst = pta.kst(c)
add("kst", {"roc": [10, 15, 20, 30], "sma": [10, 10, 10, 15], "signal": 9},
    {"kst": C(kst, "KST_10_15_20_30_10_10_10_15"), "signal": C(kst, "KSTs_9")})

smi = pta.smi(c, fast=5, slow=20, signal=5)
add("smi", {"fast": 5, "slow": 20, "signal": 5},
    {"smi": C(smi, "SMI_5_20_5_1.0"), "signal": C(smi, "SMIs_5_20_5_1.0"),
     "osc": C(smi, "SMIo_5_20_5_1.0")})

qqe = pta.qqe(c, length=14, smooth=5, factor=4.236)
add("qqe", {"length": 14, "smooth": 5, "factor": 4.236},
    {"line": C(qqe, "QQE_14_5_4.236"), "rsima": C(qqe, "QQE_14_5_4.236_RSIMA")})

# ───────────────────────── bars-input ─────────────────────────
aber = pta.aberration(h, l, c, length=5, atr_length=15)
add("aberration", {"length": 5, "atr_length": 15},
    {"zg": C(aber, "ABER_ZG_5_15"), "sg": C(aber, "ABER_SG_5_15"),
     "xg": C(aber, "ABER_XG_5_15"), "atr": C(aber, "ABER_ATR_5_15")})

accb = pta.accbands(h, l, c, length=20)
add("accbands", {"length": 20, "c": 4},
    {"lower": C(accb, "ACCBL_20"), "mid": C(accb, "ACCBM_20"), "upper": C(accb, "ACCBU_20")})

adx = pta.adx(h, l, c, length=14)
add("adx", {"length": 14},
    {"adx": C(adx, "ADX_14"), "adxr": C(adx, "ADXR_14_2"),
     "dmp": C(adx, "DMP_14"), "dmn": C(adx, "DMN_14")})

aobv = pta.aobv(c, v, fast=4, slow=12, max_lookback=2, min_lookback=2, run_length=2)
add("aobv", {"fast": 4, "slow": 12, "run_length": 2},
    {"obv": C(aobv, "OBV"), "fast": C(aobv, "OBVe_4"), "slow": C(aobv, "OBVe_12")})

brar = pta.brar(o, h, l, c, length=26)
add("brar", {"length": 26}, {"ar": C(brar, "AR_26"), "br": C(brar, "BR_26")})

cksp = pta.cksp(h, l, c)
add("cksp", {"cols": list(cksp.columns)},
    {"long": cksp.iloc[:, 0], "short": cksp.iloc[:, 1]})

dm = pta.dm(h, l, length=14)
add("dm", {"length": 14}, {"plus": C(dm, "DMP_14"), "minus": C(dm, "DMN_14")})

donch = pta.donchian(h, l, lower_length=20, upper_length=20)
add("donchian", {"lower_length": 20, "upper_length": 20},
    {"lower": C(donch, "DCL_20_20"), "mid": C(donch, "DCM_20_20"), "upper": C(donch, "DCU_20_20")})

add("eom", {"length": 14, "divisor": 100000000}, {"real": pta.eom(h, l, c, v, length=14)})

eri = pta.eri(h, l, c, length=13)
add("eri", {"length": 13}, {"bull": C(eri, "BULLP_13"), "bear": C(eri, "BEARP_13")})

fish = pta.fisher(h, l, length=9, signal=1)
add("fisher", {"length": 9, "signal": 1},
    {"fisher": C(fish, "FISHERT_9_1"), "signal": C(fish, "FISHERTs_9_1")})

ha = pta.ha(o, h, l, c)
add("ha", {}, {"open": ha["HA_open"], "high": ha["HA_high"],
               "low": ha["HA_low"], "close": ha["HA_close"]})

hilo = pta.hilo(h, l, c, high_length=13, low_length=21)
add("hilo", {"high_length": 13, "low_length": 21},
    {"hilo": C(hilo, "HILO_13_21"), "long": C(hilo, "HILOl_13_21"), "short": C(hilo, "HILOs_13_21")})

hwc = pta.hwc(c)
add("hwc", {"na": 0.2, "nb": 0.1, "nc": 0.1, "nd": 0.1, "scalar": 1},
    {"mid": C(hwc, "HWM_1"), "lower": C(hwc, "HWL_1"), "upper": C(hwc, "HWU_1")})

ich = pta.ichimoku(h, l, c)[0]
add("ichimoku", {"tenkan": 9, "kijun": 26, "senkou": 52},
    {"tenkan": C(ich, "ITS_9"), "kijun": C(ich, "IKS_26")})

add("inertia", {"length": 20, "rvi_length": 14},
    {"real": pta.inertia(c, h, l, length=20, rvi_length=14)})

kc = pta.kc(h, l, c, length=20, scalar=2)
add("kc", {"length": 20, "scalar": 2},
    {"lower": C(kc, "KCLe_20_2"), "mid": C(kc, "KCBe_20_2"), "upper": C(kc, "KCUe_20_2")})

kdj = pta.kdj(h, l, c, length=9, signal=3)
add("kdj", {"length": 9, "signal": 3},
    {"k": C(kdj, "K_9_3"), "d": C(kdj, "D_9_3"), "j": C(kdj, "J_9_3")})

kvo = pta.kvo(h, l, c, v, fast=34, slow=55, signal=13)
add("kvo", {"fast": 34, "slow": 55, "signal": 13},
    {"kvo": C(kvo, "KVO_34_55_13"), "signal": C(kvo, "KVOs_34_55_13")})

add("nvi", {}, {"real": pta.nvi(c, v)})
add("pvi", {}, {"real": pta.pvi(c, v).iloc[:, 0] if isinstance(pta.pvi(c, v), pd.DataFrame) else pta.pvi(c, v)})
add("pgo", {"length": 14}, {"real": pta.pgo(h, l, c, length=14)})
add("pvol", {}, {"real": pta.pvol(c, v)})
add("pvr", {}, {"real": pta.pvr(c, v)})
add("pvt", {}, {"real": pta.pvt(c, v)})

pvo = pta.pvo(v, fast=12, slow=26, signal=9)
add("pvo", {"fast": 12, "slow": 26, "signal": 9},
    {"pvo": C(pvo, "PVO_12_26_9"), "hist": C(pvo, "PVOh_12_26_9"), "signal": C(pvo, "PVOs_12_26_9")})

rvgi = pta.rvgi(o, h, l, c, length=14)
add("rvgi", {"length": 14}, {"rvgi": C(rvgi, "RVGI_14_4"), "signal": C(rvgi, "RVGIs_14_4")})

add("rvi", {"length": 14}, {"real": pta.rvi(c, h, l, length=14)})

squeeze = pta.squeeze(h, l, c)
add("squeeze", {"bb_length": 20, "bb_std": 2.0, "kc_length": 20, "kc_scalar": 1.5},
    {"sqz": C(squeeze, "SQZ_20_2.0_20_1.5"), "on": C(squeeze, "SQZ_ON"),
     "off": C(squeeze, "SQZ_OFF"), "no": C(squeeze, "SQZ_NO")})

szp = pta.squeeze_pro(h, l, c)
add("squeeze_pro", {"bb_length": 20, "bb_std": 2.0, "kc_length": 20},
    {"sqz": C(szp, "SQZPRO_20_2.0_20_2.0_1.5_1.0")})

thermo = pta.thermo(h, l, length=20, long=2, short=0.5)
add("thermo", {"length": 20, "long": 2, "short": 0.5},
    {"thermo": C(thermo, "THERMO_20_2_0.5"), "ma": C(thermo, "THERMOma_20_2_0.5")})

add("ttm_trend", {"length": 6}, {"real": pta.ttm_trend(h, l, c, length=6).iloc[:, 0]})

# ───────────────────────── pair-input (two MAs) ─────────────────────────
fast_ema = pta.ema(c, 8)
slow_ema = pta.ema(c, 21)
add("long_run", {"length": 2, "fast": "ema8", "slow": "ema21"},
    {"real": pta.long_run(fast_ema, slow_ema, length=2)})
add("short_run", {"length": 2, "fast": "ema8", "slow": "ema21"},
    {"real": pta.short_run(fast_ema, slow_ema, length=2)})

with open(os.path.join(OUT, "pandas-ta-ext-golden.json"), "w") as f:
    json.dump({"meta": META, "dataset": "reference-ohlcv.json", "entries": entries}, f)
print(f"wrote pandas-ta-ext-golden.json ({len(entries)} entries)")
for e in entries:
    print("  ", e["name"], list(e["outputs"].keys()))
