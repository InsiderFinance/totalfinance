#!/usr/bin/env python3
"""Generate the WS9.5a distribution golden fixture from SciPy — the named reference implementation.

SciPy's `scipy.stats` (Student-t, chi-square, gamma) and `scipy.special` (regularized incomplete
gamma/beta) are the reference against which `packages/math/src/distributions.ts` is checked. This
script emits a committed JSON vector so CI needs NO Python (the drift is caught by the TS test, the
same pattern as the TA golden guides). Regenerate after touching distributions.ts:

    python3 tools/golden/generate_distributions.py

Requires only numpy + scipy (no statsmodels/arch).
"""

import json
import os

import numpy as np
import scipy
from scipy import special, stats

CASES = []


def add(fn, args, expected):
    CASES.append({"fn": fn, "args": [float(a) for a in args], "expected": float(expected)})


# Student's t — cdf / pdf / ppf(inv) across light and heavy tails.
for df in (1, 2, 3, 5, 10, 30, 100):
    for x in (-3.0, -1.5, -0.5, 0.0, 0.5, 1.5, 2.5, 4.0):
        add("studentT.cdf", [x, df], stats.t.cdf(x, df))
        add("studentT.pdf", [x, df], stats.t.pdf(x, df))
    for p in (0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 0.999):
        add("studentT.inv", [p, df], stats.t.ppf(p, df))

# Chi-square — cdf / ppf.
for df in (1, 2, 3, 5, 8, 15, 30):
    for x in (0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0):
        add("chiSquare.cdf", [x, df], stats.chi2.cdf(x, df))
    for p in (0.01, 0.1, 0.5, 0.9, 0.99):
        add("chiSquare.inv", [p, df], stats.chi2.ppf(p, df))

# Gamma(shape k, scale theta) — cdf / ppf. SciPy: gamma(a=k, scale=theta).
for k in (0.5, 1.0, 2.0, 3.5, 7.0):
    for theta in (0.5, 1.0, 2.0):
        for x in (0.25, 1.0, 3.0, 6.0):
            add("gamma.cdf", [x, k, theta], stats.gamma.cdf(x, k, scale=theta))
        for p in (0.05, 0.5, 0.95):
            add("gamma.inv", [p, k, theta], stats.gamma.ppf(p, k, scale=theta))

# Regularized incomplete gamma P(a, x) = scipy.special.gammainc.
for a in (0.5, 1.0, 2.5, 5.0, 12.0):
    for x in (0.1, 0.5, 1.0, 3.0, 8.0, 20.0):
        add("regularizedGammaP", [a, x], special.gammainc(a, x))

# Regularized incomplete beta I_x(a, b) = scipy.special.betainc.
for a in (0.5, 1.0, 2.0, 5.0):
    for b in (0.5, 1.5, 3.0):
        for x in (0.1, 0.3, 0.5, 0.7, 0.9):
            add("regularizedBeta", [a, b, x], special.betainc(a, b, x))

fixture = {
    "_meta": {
        "source": f"scipy {scipy.__version__} / numpy {np.__version__}",
        "generator": "tools/golden/generate_distributions.py",
        "note": (
            "Reference values for @totalfinance/math distributions (studentT, chiSquare, gamma, "
            "regularizedGammaP, regularizedBeta). CI reads this committed file; no Python required."
        ),
    },
    "cases": CASES,
}

out = os.path.join(
    os.path.dirname(__file__), "..", "..", "packages", "math", "test", "fixtures",
    "distributions.golden.json",
)
out = os.path.normpath(out)
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w") as f:
    json.dump(fixture, f, indent=2)
    f.write("\n")
print(f"wrote {out} ({len(CASES)} cases)")
