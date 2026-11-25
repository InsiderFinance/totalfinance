#!/usr/bin/env python3
"""
Independent golden vectors for the Bjerksund–Stensland American approximations.

Every value comes from `bjerksund_stensland_reference.py`: the published 1993/2002 formulas evaluated
term for term in mpmath (40–50 significant digits, unbounded exponent range). No value comes from
TotalFinance. The reference first reproduces three published Bjerksund–Stensland 2002 values
(NAG S30QCF, MathWorks optstockbybjs and optstocksensbybjs), which are stored here as anchors.

Greeks are taken two ways, in the library's documented units (delta raw, gamma raw, theta per
calendar day = −∂V/∂T / 365, vega per vol point = ∂V/∂σ / 100, rho per 1% = ∂V/∂r / 100):

  * `finiteDifference`: the engine's OWN central differences, using its bump sizes. These are
    S·1e-3, min(1e-3, σ/4), min(1e-4, T/4) and 1e-4. The bumped coordinates are rounded to binary64
    exactly as the engine rounds them, and the quotients are evaluated in mpmath. This isolates the
    engine's floating-point evaluation error, because the truncation error is identical.
  * `derivative`: the model's true derivative (central differences with h = 1e-12 relative at 50
    digits, so truncation and rounding are both below 1e-20). Compared with `finiteDifference`, it
    gives the bump policy's truncation error, which is reported separately.

Reproduce with mpmath installed (about 10 minutes on 10 cores):

    python3 tools/golden/generate_bjerksund_stensland.py

Output (committed, so CI needs no Python):
  packages/options/test/golden/bjerksund-stensland-mpmath.json
"""

from __future__ import annotations

import json
import os
import platform
import sys
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mpmath as mp  # noqa: E402

import bjerksund_stensland_reference as R  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "options", "test", "golden"))

# Engine time arithmetic: expiresAt = asOf + years·YEAR_MS; T = ((expiresAt − asOf) / MS_PER_DAY) / 365.
AS_OF_MS = 1795993200000  # 2026-11-24T15:00:00Z
MS_PER_DAY = 86_400_000
YEAR_MS = 365 * MS_PER_DAY


def engine_years(years):
    return ((AS_OF_MS + years * YEAR_MS) - AS_OF_MS) / MS_PER_DAY / 365


def case(kind, spot, strike, years, r, q, sigma):
    return {
        "type": kind,
        "spot": spot,
        "strike": strike,
        "years": years,
        "timeToExpiryYears": engine_years(years),
        "riskFreeRate": r,
        "dividendYield": q,
        "volatility": sigma,
    }


def nstr(x):
    # 25 significant digits survive the JSON float round-trip comfortably; doubles keep ~17.
    return float(mp.nstr(x, 25))


def price_of(form, c, floor, **overrides):
    v = {**c, **overrides}
    return R.american_price(
        form, v["type"], v["spot"], v["strike"], v["timeToExpiryYears"],
        v["riskFreeRate"], v["dividendYield"], v["volatility"], floor=floor,
    )


# ---------------------------------------------------------------------------------- case sets

ANCHORS = [
    # NAG Library S30QCF (Mark 25) example program results: printed 10.3340.
    {"source": "NAG S30QCF example", "printed": 10.3340, "decimals": 4,
     **case("call", 110, 100, 0.25, 0.08, 0.12, 0.2)},
    # MathWorks optstockbybjs example (Settle 2008-01-01, Maturity 2008-04-01, actual/actual = 91/366).
    {"source": "MathWorks optstockbybjs example", "printed": 0.8420, "decimals": 4,
     **{**case("call", 90, 100, 0.25, 0.08, 0.04, 0.2), "timeToExpiryYears": 91 / 366}},
    {"source": "MathWorks optstockbybjs example", "printed": 0.1108, "decimals": 4,
     **{**case("put", 120, 100, 0.25, 0.08, 0.04, 0.2), "timeToExpiryYears": 91 / 366}},
    # MathWorks optstocksensbybjs example (Settle 2008-06-01, Maturity 2008-10-01 = 122/366).
    *[
        {"source": "MathWorks optstocksensbybjs example", "printed": printed, "decimals": 4,
         **{**case("put", spot, 100, 1 / 3, 0.08, 0.04, 0.4), "timeToExpiryYears": 122 / 366}}
        for spot, printed in ((90, 13.7594), (100, 8.4830), (110, 4.9451), (120, 2.7475))
    ],
]

PRICE_CASES = []
# The two reported reproductions and the rate-bump states around the second.
for kind in ("call", "put"):
    PRICE_CASES.append(case(kind, 100, 100, 1 / 365, 0.05, 0.01, 0.01))
    for r in (0.0, 1e-4, -1e-4, 1e-8, -1e-8):
        PRICE_CASES.append(case(kind, 140, 100, 0.5, r, 0.12, 0.05))
# Low-volatility regimes across moneyness, maturity, sign of the rate and carry.
for kind in ("call", "put"):
    for sigma in (0.001, 0.01, 0.05):
        for spot in (60, 95, 100, 105, 140):
            for years in (1 / 365, 0.5, 2.0):
                for r, q in ((0.05, 0.01), (0.0, 0.12), (-0.01, 0.04), (0.04, 0.0), (0.25, 0.25)):
                    if (spot + int(years * 365) + int(sigma * 1000) + int(r * 100)) % 3 == 0:
                        PRICE_CASES.append(case(kind, spot, 100, years, r, q, sigma))
# Ordinary and high volatility (normal-case consistency), tails and monetary scales.
for kind in ("call", "put"):
    for spot, strike, years, r, q, sigma in (
        (100, 100, 1.0, 0.05, 0.0, 0.2),
        (90, 100, 1.0, 0.03, 0.0, 0.35),
        (100, 100, 1.0, 0.05, 0.06, 0.2),
        (110, 100, 1.0, 0.04, 0.07, 0.25),
        (40, 40, 1.0, 0.06, 0.0, 0.2),
        (100, 100, 0.5, -0.05, -0.02, 0.3),
        (100, 100, 2.0, 0.05, 0.01, 2.0),
        (100, 100, 10.0, 0.25, 0.0, 10.0),
        (1e-4, 1e-4, 1 / 365, 0.05, 0.01, 0.01),
        (1e6, 1e6, 1 / 365, 0.05, 0.01, 0.01),
        (1, 1e7, 1.0, 0.25, 0.25, 0.25),
        (1e7, 1, 1.0, -0.05, 0.25, 0.25),
    ):
        PRICE_CASES.append(case(kind, spot, strike, years, r, q, sigma))
# Carry approaching the rate from below (b → r⁻: the European branch is the limit).
# A call reaches it as q → 0⁺; a put (transformed carry q − r, rate q) as r → 0⁺.
for small in (1e-3, 1e-6, 1e-10, 1e-14):
    PRICE_CASES.append(case("call", 100, 100, 0.5, 0.05, small, 0.01))
    PRICE_CASES.append(case("put", 100, 100, 0.5, small, 0.05, 0.01))

GREEK_CASES = [
    case("call", 100, 100, 1 / 365, 0.05, 0.01, 0.01),
    case("put", 100, 100, 1 / 365, 0.05, 0.01, 0.01),
    case("put", 140, 100, 0.5, 0.0, 0.12, 0.05),
    case("call", 140, 100, 0.5, 0.0, 0.12, 0.05),
    case("put", 100, 100, 0.5, 0.0, 0.0, 0.01),
    case("call", 100, 100, 0.5, -0.01, 0.04, 0.01),
    case("put", 100, 100, 0.5, -0.01, 0.0, 0.01),
    case("call", 100, 95, 0.5, 0.05, 0.1, 0.01),
    case("put", 95, 100, 2.0, 0.05, 0.0, 0.05),
    case("call", 100, 100, 0.1, 0.04, 0.05, 0.05),
    case("put", 100, 100, 1.0, 0.05, 0.0, 0.2),
    case("call", 100, 100, 1.0, 0.05, 0.06, 0.2),
    case("put", 90, 100, 0.25, 0.25, 0.0, 0.25),
    case("call", 100, 100, 1.0, 0.05, 0.01, 2.0),
]

MATRIX_COLUMNS = ["type", "spot", "strike", "years", "riskFreeRate", "dividendYield", "volatility"]
MATRIX_CASES = []
# The full 972-case boundary grid.
for kind in ("call", "put"):
    for r in (-0.05, 0.0, 0.25):
        for q in (0.0, 0.25):
            for sigma in (0.001, 0.25, 10.0):
                for spot in (1, 100, 1e7):
                    for strike in (1, 100, 1e7):
                        for years in (1 / 365, 1.0, 10.0):
                            MATRIX_CASES.append(case(kind, spot, strike, years, r, q, sigma))
# The low-volatility, near-the-money slice of the 12,000-case grid.
for kind in ("call", "put"):
    for r in (-0.01, 0.0, 0.04, 0.05):
        for q in (0.0, 0.01, 0.04, 0.05, 0.12):
            for sigma in (0.01, 0.05):
                for spot in (60, 100, 140):
                    for years in (1 / 365, 0.1, 0.5, 2.0):
                        MATRIX_CASES.append(case(kind, spot, 100, years, r, q, sigma))


# ---------------------------------------------------------------------------------- workers

def anchor_job(c):
    R.set_digits(50)
    return {**c, "reference": nstr(price_of("2002", c, floor=False))}


def price_job(c):
    R.set_digits(50)
    out = {**c}
    for form in ("2002", "1993"):
        raw = price_of(form, c, floor=False)
        args = (c[k] for k in ("type", "spot", "strike", "timeToExpiryYears", "riskFreeRate",
                               "dividendYield", "volatility"))
        out[f"approximation{form}"] = nstr(raw)
        out[f"price{form}"] = nstr(R.american_floor(*args, raw))
    return out


def engine_bumps(c):
    S, T, sigma = c["spot"], c["timeToExpiryYears"], c["volatility"]
    return {
        "spotStep": S * 1e-3,
        "volatilityStep": min(1e-3, sigma / 4),
        "timeStepYears": min(1e-4, T / 4),
        "rateStep": 1e-4,
    }


def greek_job(c):
    R.set_digits(50)
    form = "2002"
    S, T, r, sigma = (c[k] for k in ("spot", "timeToExpiryYears", "riskFreeRate", "volatility"))
    bumps = engine_bumps(c)
    h_s, h_v, h_t, h_r = (bumps[k] for k in ("spotStep", "volatilityStep", "timeStepYears", "rateStep"))
    p = lambda **o: price_of(form, c, floor=True, **o)  # noqa: E731
    base = p()
    # The engine's own stencil: bumped coordinates are binary64 sums, exactly as in JavaScript.
    fd = {
        "delta": (p(spot=S + h_s) - p(spot=S - h_s)) / (2 * mp.mpf(h_s)),
        "gamma": (p(spot=S + h_s) - 2 * base + p(spot=S - h_s)) / (mp.mpf(h_s) ** 2),
        "theta": -(p(timeToExpiryYears=T + h_t) - p(timeToExpiryYears=T - h_t)) / (2 * mp.mpf(h_t)) / 365,
        "vega": (p(volatility=sigma + h_v) - p(volatility=sigma - h_v)) / (2 * mp.mpf(h_v)) / 100,
        "rho": (p(riskFreeRate=r + h_r) - p(riskFreeRate=r - h_r)) / (2 * mp.mpf(h_r)) / 100,
    }
    # True derivatives: tiny exact-arithmetic steps (the inputs are mpf, never rounded to binary64).
    e = mp.mpf(10) ** -12
    S_, T_, r_, v_ = (mp.mpf(x) for x in (S, T, r, sigma))
    ds, dt, dv = S_ * e, T_ * e, v_ * e
    dr = e
    eg = mp.mpf(10) ** -9
    dsg = S_ * eg
    exact = {
        "delta": (p(spot=S_ + ds) - p(spot=S_ - ds)) / (2 * ds),
        "gamma": (p(spot=S_ + dsg) - 2 * base + p(spot=S_ - dsg)) / (dsg * dsg),
        "theta": -(p(timeToExpiryYears=T_ + dt) - p(timeToExpiryYears=T_ - dt)) / (2 * dt) / 365,
        "vega": (p(volatility=v_ + dv) - p(volatility=v_ - dv)) / (2 * dv) / 100,
        "rho": (p(riskFreeRate=r_ + dr) - p(riskFreeRate=r_ - dr)) / (2 * dr) / 100,
    }
    return {
        **c,
        "price": nstr(base),
        "bumps": bumps,
        "finiteDifference": {k: nstr(v) for k, v in fd.items()},
        "derivative": {k: nstr(v) for k, v in exact.items()},
    }


LOG_NORMAL_CDF_POINTS = [-1e4, -1000.0, -200.0, -40.0, -37.0, -30.0, -20.0, -12.5, -8.5, -8.0, -7.07,
                         -5.0, -3.0, -2.0000000000000004, -2.0, -1.0, 0.0, 1.0, 8.0, 30.0]


def kernel_log_normal_cdf(x):
    R.set_digits(50)
    return {"x": x, "value": nstr(mp.log(mp.ncdf(mp.mpf(x))))}


# Weighted bivariate terms with the ARGUMENTS BS2002's Ψ actually produces. That covers the
# overflow × underflow reproduction (weights near e^{1300}) and knife-edge spots whose deterministic
# path just reaches I2, where the weighted terms are O(1). Inputs are rounded to binary64 first. The
# expected value is exact at those rounded inputs.
KNIFE_EDGE_CONFIGS = [
    # (S, K, T, r, b, sigma); S = None means "0.99 × I2" (the knife-edge spot).
    (100, 100, 1 / 365, 0.05, 0.04, 0.01),
    (None, 100, 0.5, 0.05, 0.04, 0.005),
    (None, 100, 2.0, 0.05, 0.01, 0.002),
    (None, 100, 0.5, 0.03, -0.01, 0.01),
    (None, 100, 2.0, 0.0, -0.01, 0.01),
]


def _boundaries(K, T, r, b, sigma):
    beta, b_inf, b0 = R._beta_and_boundaries(K, r, b, sigma)
    t1 = (mp.sqrt(5) - 1) / 2 * T
    bd = lambda t: b0 + (b_inf - b0) * (1 - mp.exp(-(b * t + 2 * sigma * mp.sqrt(t)) * (K * K / ((b_inf - b0) * b0))))  # noqa: E731,E501
    return beta, t1, bd(t1), bd(T)


def _psi_term_arguments():
    R.set_digits(50)
    out = []
    for S, K, T, r, b, sigma in KNIFE_EDGE_CONFIGS:
        K, T, r, b, sigma = map(mp.mpf, (K, T, r, b, sigma))
        beta, t1, I1, I2 = _boundaries(K, T, r, b, sigma)
        S = mp.mpf(S) if S is not None else mp.mpf(float(I2 * mp.mpf("0.99")))
        rho = mp.sqrt(t1 / T)
        for gamma in (beta, 1, 0):
            drift = b + (gamma - mp.mpf(1) / 2) * sigma**2
            kappa = 2 * b / sigma**2 + 2 * gamma - 1
            s1, s2 = sigma * mp.sqrt(t1), sigma * mp.sqrt(T)
            for H in (I1, K):
                e = [(mp.log(S / I1) + drift * t1) / s1, (mp.log(I2 * I2 / (S * I1)) + drift * t1) / s1,
                     (mp.log(S / I1) - drift * t1) / s1, (mp.log(I2 * I2 / (S * I1)) - drift * t1) / s1]
                f = [(mp.log(S / H) + drift * T) / s2, (mp.log(I2 * I2 / (S * H)) + drift * T) / s2,
                     (mp.log(I1 * I1 / (S * H)) + drift * T) / s2,
                     (mp.log(S * I1 * I1 / (H * I2 * I2)) + drift * T) / s2]
                powers = [0, kappa * mp.log(I2 / S), kappa * mp.log(I1 / S), kappa * mp.log(I1 / I2)]
                for j in range(4):
                    out.append({"firstLimit": float(-e[j]), "secondLimit": float(-f[j]),
                                "correlation": float(rho if j < 2 else -rho), "logWeight": float(powers[j])})
    return out


WEIGHTED_BIVARIATE_CASES = _psi_term_arguments()


def kernel_weighted_bivariate(c):
    R.set_digits(50)
    value = mp.exp(mp.mpf(c["logWeight"])) * R.bvn(c["firstLimit"], c["secondLimit"], c["correlation"])
    return {**c, "value": nstr(value)}


def matrix_job(c):
    R.set_digits(40)
    return [c[k] for k in MATRIX_COLUMNS] + [c["timeToExpiryYears"], nstr(price_of("2002", c, floor=True))]


if __name__ == "__main__":
    R.set_digits(50)
    R.self_check()
    workers = int(os.environ.get("GOLDEN_WORKERS", os.cpu_count() or 1))
    with Pool(workers) as pool:
        anchors = pool.map(anchor_job, ANCHORS, chunksize=1)
        prices = pool.map(price_job, PRICE_CASES, chunksize=1)
        greeks = pool.map(greek_job, GREEK_CASES, chunksize=1)
        matrix = pool.map(matrix_job, MATRIX_CASES, chunksize=4)
        log_normal_cdf = pool.map(kernel_log_normal_cdf, LOG_NORMAL_CDF_POINTS)
        weighted_bivariate = pool.map(kernel_weighted_bivariate, WEIGHTED_BIVARIATE_CASES)
    for a in anchors:
        if abs(a["reference"] - a["printed"]) > 0.5 * 10 ** -a["decimals"]:
            raise AssertionError(f"reference does not reproduce the published anchor {a}")
    meta = {
        "generator": "tools/golden/generate_bjerksund_stensland.py",
        "reference": "tools/golden/bjerksund_stensland_reference.py — published Bjerksund–Stensland 1993/2002 "
                     "formulas in mpmath (bivariate normal by cross-checked adaptive quadrature)",
        "price": "floored engine semantics max(approximation, intrinsic, European); `approximation*` are raw",
        "greekUnits": {"delta": "per unit spot", "gamma": "per unit spot squared",
                       "theta": "per calendar day (−∂V/∂T / 365)", "vega": "per vol point (∂V/∂σ / 100)",
                       "rho": "per 1% rate (∂V/∂r / 100)"},
        "asOfMs": AS_OF_MS,
        "mpmath": mp.__version__,
        "precision": "50 significant digits (matrix: 40)",
        "python": platform.python_version(),
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "bjerksund-stensland-mpmath.json"), "w") as f:
        json.dump({"meta": meta, "anchors": anchors, "prices": prices, "greeks": greeks,
                   "matrix": {"columns": MATRIX_COLUMNS + ["timeToExpiryYears", "price2002"], "rows": matrix},
                   "kernels": {"logNormalCdf": log_normal_cdf, "weightedBivariateNormalCdf": weighted_bivariate}},
                  f, indent=None, separators=(",", ":"))
        f.write("\n")
    print(f"wrote bjerksund-stensland-mpmath.json ({len(anchors)} anchors, {len(prices)} prices, "
          f"{len(greeks)} greek cases, {len(matrix)} matrix rows)")
