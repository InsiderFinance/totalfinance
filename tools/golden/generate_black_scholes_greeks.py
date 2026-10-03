#!/usr/bin/env python3
"""
Independent golden vectors for the selective Black–Scholes evaluation kernel.

Every value here comes from mpmath at 50 significant digits and NONE from TotalFinance or from a
closed-form Greek formula: the price is the Black–Scholes–Merton formula evaluated in mpmath, and
every Greek is a numerical derivative (`mpmath.diff`) of that price. A defect in the library's
closed-form Greek expressions therefore cannot also appear here.

Units follow the library's documented conventions, applied to the exact derivatives:

    price  V                        delta  ∂V/∂S                 gamma ∂²V/∂S²
    theta  −(∂V/∂T) / 365           vega   (∂V/∂σ) / 100         rho   (∂V/∂r) / 100
    vanna  ∂²V/∂S∂σ                 charm  ∂²V/∂S∂T (∂Δ/∂T)      vomma ∂²V/∂σ²
    speed  ∂³V/∂S³                  color  ∂³V/∂S²∂T (∂Γ/∂T)

T is time to expiry (charm and color are per ADDED year of time-to-expiry; theta is per calendar
day ELAPSED). Reproduce with mpmath installed:

    python3 tools/golden/generate_black_scholes_greeks.py

Output (committed, so CI needs no Python):
  packages/options/test/golden/black-scholes-greeks-mpmath.json
"""

from __future__ import annotations

import json
import os
import platform

import mpmath as mp

mp.mp.dps = 50

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "options", "test", "golden"))
os.makedirs(OUT, exist_ok=True)


def price(call, S, K, T, r, q, sigma):
    S, K, T, r, q, sigma = (mp.mpf(x) for x in (S, K, T, r, q, sigma))
    sqrt_t = mp.sqrt(T)
    d1 = (mp.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    if call:
        return S * mp.exp(-q * T) * mp.ncdf(d1) - K * mp.exp(-r * T) * mp.ncdf(d2)
    return K * mp.exp(-r * T) * mp.ncdf(-d2) - S * mp.exp(-q * T) * mp.ncdf(-d1)


def reference(case):
    call = case["type"] == "call"
    S, K, T, r, q, sigma = (
        case["spot"],
        case["strike"],
        case["timeToExpiryYears"],
        case["riskFreeRate"],
        case["dividendYield"],
        case["volatility"],
    )

    def f(s=S, t=T, rr=r, v=sigma):
        return price(call, s, K, t, rr, q, v)

    S_, T_, r_, v_ = mp.mpf(S), mp.mpf(T), mp.mpf(r), mp.mpf(sigma)
    values = {
        "price": f(),
        "delta": mp.diff(lambda s: f(s=s), S_),
        "gamma": mp.diff(lambda s: f(s=s), S_, 2),
        "theta": -mp.diff(lambda t: f(t=t), T_) / 365,
        "vega": mp.diff(lambda v: f(v=v), v_) / 100,
        "rho": mp.diff(lambda rr: f(rr=rr), r_) / 100,
        "vanna": mp.diff(lambda s, v: f(s=s, v=v), (S_, v_), (1, 1)),
        "charm": mp.diff(lambda s, t: f(s=s, t=t), (S_, T_), (1, 1)),
        "vomma": mp.diff(lambda v: f(v=v), v_, 2),
        "speed": mp.diff(lambda s: f(s=s), S_, 3),
        "color": mp.diff(lambda s, t: f(s=s, t=t), (S_, T_), (2, 1)),
    }
    # 25 significant digits survive the JSON float round-trip comfortably; doubles keep ~17.
    return {name: float(mp.nstr(value, 25)) for name, value in values.items()}


CASES = []
for kind in ("call", "put"):
    for spot, strike in ((100, 100), (100, 80), (100, 125), (6500, 6450), (7.5, 9)):
        for T in (1 / 365, 0.25, 2.0):
            for sigma in (0.05, 0.25, 1.2):
                CASES.append(
                    {
                        "type": kind,
                        "spot": spot,
                        "strike": strike,
                        "timeToExpiryYears": T,
                        "riskFreeRate": 0.045,
                        "dividendYield": 0.0,
                        "volatility": sigma,
                    }
                )
    # Carry and sign coverage: a dividend yield, a negative rate, both together.
    for r, q in ((0.045, 0.031), (-0.005, 0.0), (-0.01, 0.02)):
        CASES.append(
            {
                "type": kind,
                "spot": 100,
                "strike": 105,
                "timeToExpiryYears": 0.5,
                "riskFreeRate": r,
                "dividendYield": q,
                "volatility": 0.3,
            }
        )

entries = [{"input": case, "expected": reference(case)} for case in CASES]

META = {
    "generator": "tools/golden/generate_black_scholes_greeks.py",
    "reference": "mpmath Black–Scholes–Merton price; Greeks by mpmath.diff (no closed-form Greeks)",
    "mpmath": mp.__version__,
    "precision": "50 significant digits",
    "python": platform.python_version(),
}

with open(os.path.join(OUT, "black-scholes-greeks-mpmath.json"), "w") as f:
    json.dump({"meta": META, "entries": entries}, f, indent=1)
print(f"wrote black-scholes-greeks-mpmath.json ({len(entries)} cases)")
