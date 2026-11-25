#!/usr/bin/env python3
"""
Independent arbitrary-precision Bjerksund–Stensland reference (1993 and 2002 forms).

This module evaluates the PUBLISHED closed-form approximations directly in mpmath. It shares no code
with TotalFinance and deliberately does NOT reproduce the library's floating-point rearrangements
(log-domain terms, scaled bivariate quadrature, cancellation-free boundary algebra): every formula
below is the textbook expression, term for term. With mpmath's unbounded exponent range and
`DIGITS` significant digits there is no overflow, underflow or catastrophic cancellation to manage,
so the result is the model's exact value to far beyond binary64 precision. A defect in the library's
stable rearrangement therefore cannot also appear here.

Sources of the formulas (both state the same model):

  * P. Bjerksund and G. Stensland (2002), "Closed form valuation of American options", Discussion
    Paper 2002/09, Norwegian School of Economics (NHH), Bergen.
  * NAG Library routine S30QCF (Mark 25, 2014), "Description" — states the 2002 two-boundary price,
    t = ½(√5 − 1)T, X(τ) = B0 + (B∞ − B0)(1 − e^{h(τ)}), h(τ) = −(bτ + 2σ√τ)·X²/((B∞ − B0)B0),
    B∞ = β/(β − 1)·X, B0 = max{X, r/(r − b)·X}, β = (½ − b/σ²) + √((b/σ² − ½)² + 2r/σ²), and the put by
    the put–call transformation P(X, S, T, σ, r, q) = C(S, X, T, σ, q, r). Its published example
    (call, S = 110, X = 100, T = 0.25, σ = 0.2, r = 0.08, q = 0.12) prints 10.3340, which
    `self_check()` reproduces.
  * P. Bjerksund and G. Stensland (1993), "Closed-form approximation of American options",
    Scandinavian Journal of Management 9, S87–S99 — the single-boundary form, with
    h(T) = −(bT + 2σ√T)·B0/(B∞ − B0).

φ and Ψ are the paper's functions:

  φ(S, T | γ, H, I) = e^{λ} S^γ [N(d) − (I/S)^κ N(d − 2 ln(I/S)/(σ√T))],
      λ = (−r + γb + ½γ(γ − 1)σ²)T,  d = −[ln(S/H) + (b + (γ − ½)σ²)T]/(σ√T),  κ = 2b/σ² + (2γ − 1);

  Ψ(S, T | γ, H, I2, I1, t1) = e^{λT} S^γ [M(−e1, −f1, ρ) − (I2/S)^κ M(−e2, −f2, ρ)
                                          − (I1/S)^κ M(−e3, −f3, −ρ) + (I1/I2)^κ M(−e4, −f4, −ρ)],
      ρ = √(t1/T), with e1…e4 / f1…f4 as in the paper (and S30QCF).

The cumulative bivariate normal M(a, b, ρ) is computed by adaptive tanh-sinh quadrature of
∫_{−∞}^{a} φ(x)·N((b − ρx)/√(1 − ρ²)) dx, split around the (log-concave) integrand's mode, and is
cross-checked against the transposed integral ∫_{−∞}^{b} φ(y)·N((a − ρy)/√(1 − ρ²)) dy. The two are
different integrands; a disagreement beyond `BVN_AGREEMENT` aborts generation.

TotalFinance's published engines also apply a documented FLOOR, max(approximation, intrinsic,
European BSM) — both forms are lower bounds that can fall below it out of their accurate region.
`american_price(..., floor=True)` reproduces that semantic in mpmath so goldens can be compared with
the public engine; `floor=False` returns the raw approximation.
"""

from __future__ import annotations

import mpmath as mp

DIGITS = 50
BVN_AGREEMENT = mp.mpf(10) ** -30

mp.mp.dps = DIGITS


def set_digits(digits):
    """Working precision for every evaluation (goldens use the default 50; bulk sweeps may use less)."""
    global DIGITS, BVN_AGREEMENT
    DIGITS = digits
    BVN_AGREEMENT = mp.mpf(10) ** -(digits * 3 // 5)
    mp.mp.dps = digits


def _mpf(x):
    return x if isinstance(x, mp.mpf) else mp.mpf(x)


# ---------------------------------------------------------------- normal distributions

def ncdf(x):
    return mp.ncdf(x)


def _bvn_one_order(a, b, rho):
    """∫_{−∞}^{a} φ(x)·N((b − ρx)/s) dx with s = √(1 − ρ²), split around the integrand's mode."""
    s = mp.sqrt(1 - rho * rho)

    def g(x):
        return mp.npdf(x) * mp.ncdf((b - rho * x) / s)

    def dlog_g(x):
        z = (b - rho * x) / s
        # d/dx log N(z) = (−ρ/s)·φ(z)/N(z); mpmath's exponent range keeps the ratio exact in tails.
        return -x - (rho / s) * mp.npdf(z) / mp.ncdf(z)

    # log g is concave (sum of two log-concave terms), so dlog_g is decreasing.
    slope_at_a = dlog_g(a)
    if slope_at_a >= 0:
        # Mass piles up against the upper limit; its width is ~1/slope (and never more than ~1).
        scale = 1 / max(slope_at_a, mp.mpf(1))
        points = [a - scale * k for k in (1024, 64, 8, 1, 0)]
    else:
        lo = a - 1
        while dlog_g(lo) <= 0:
            lo = a - 2 * (a - lo)
        hi = a
        # The mode only places quadrature breakpoints, so locating it to 1e-3 is plenty.
        while hi - lo > mp.mpf(10) ** -3:
            mid = (lo + hi) / 2
            if dlog_g(mid) > 0:
                lo = mid
            else:
                hi = mid
        mode = (lo + hi) / 2
        # Curvature of −log g is between 1 and 1/s², so the bulk lies within a few units of the mode.
        offsets = (-48, -12, -3, 0, 3, 12, 48)
        points = [mode + k for k in offsets if mode + k < a] + [a]
    points = [-mp.inf] + sorted(set(points))
    # mp.quad's convergence test is ABSOLUTE (≈ 10^−DIGITS), which is meaningless for a 1e-58 tail
    # probability. Normalize by the integrand's peak so the quadrature works on an O(1) function,
    # then restore the scale: the result carries DIGITS RELATIVE digits however small it is.
    peak = g(points[-1] if slope_at_a >= 0 else mode)
    value, error = mp.quad(lambda x: g(x) / peak, points, error=True)
    if error > mp.mpf(10) ** (-(DIGITS - 10)) * max(abs(value), mp.mpf(1)):
        raise ArithmeticError(f"bivariate normal quadrature did not converge at a={a}, b={b}")
    return value * peak


def bvn(a, b, rho):
    """P(X ≤ a, Y ≤ b) for a standard bivariate normal with correlation rho (|rho| < 1)."""
    a, b, rho = _mpf(a), _mpf(b), _mpf(rho)
    if rho == 0:
        return ncdf(a) * ncdf(b)
    first = _bvn_one_order(a, b, rho)
    second = _bvn_one_order(b, a, rho)
    scale = max(abs(first), abs(second))
    if scale > 0 and abs(first - second) > BVN_AGREEMENT * scale:
        raise ArithmeticError(f"bivariate normal quadratures disagree at a={a}, b={b}, rho={rho}")
    return (first + second) / 2


# ---------------------------------------------------------------- generalized BSM (carry b)

def european(call, S, K, T, r, b, sigma):
    S, K, T, r, b, sigma = map(_mpf, (S, K, T, r, b, sigma))
    vol = sigma * mp.sqrt(T)
    d1 = (mp.log(S / K) + (b + sigma * sigma / 2) * T) / vol
    d2 = d1 - vol
    if call:
        return S * mp.exp((b - r) * T) * ncdf(d1) - K * mp.exp(-r * T) * ncdf(d2)
    return K * mp.exp(-r * T) * ncdf(-d2) - S * mp.exp((b - r) * T) * ncdf(-d1)


# ---------------------------------------------------------------- the paper's φ and Ψ

def phi(S, T, gamma, H, I, r, b, sigma):
    sig2 = sigma * sigma
    lam = (-r + gamma * b + gamma * (gamma - 1) * sig2 / 2) * T
    d = -(mp.log(S / H) + (b + (gamma - mp.mpf(1) / 2) * sig2) * T) / (sigma * mp.sqrt(T))
    kappa = 2 * b / sig2 + (2 * gamma - 1)
    return (
        mp.exp(lam)
        * S**gamma
        * (ncdf(d) - (I / S) ** kappa * ncdf(d - 2 * mp.log(I / S) / (sigma * mp.sqrt(T))))
    )


def psi(S, T2, gamma, H, I2, I1, t1, r, b, sigma):
    sig2 = sigma * sigma
    drift = b + (gamma - mp.mpf(1) / 2) * sig2
    s1, s2 = sigma * mp.sqrt(t1), sigma * mp.sqrt(T2)
    e1 = (mp.log(S / I1) + drift * t1) / s1
    e2 = (mp.log(I2 * I2 / (S * I1)) + drift * t1) / s1
    e3 = (mp.log(S / I1) - drift * t1) / s1
    e4 = (mp.log(I2 * I2 / (S * I1)) - drift * t1) / s1
    f1 = (mp.log(S / H) + drift * T2) / s2
    f2 = (mp.log(I2 * I2 / (S * H)) + drift * T2) / s2
    f3 = (mp.log(I1 * I1 / (S * H)) + drift * T2) / s2
    f4 = (mp.log(S * I1 * I1 / (H * I2 * I2)) + drift * T2) / s2
    rho = mp.sqrt(t1 / T2)
    lam = -r + gamma * b + gamma * (gamma - 1) * sig2 / 2
    kappa = 2 * b / sig2 + (2 * gamma - 1)
    return (
        mp.exp(lam * T2)
        * S**gamma
        * (
            bvn(-e1, -f1, rho)
            - (I2 / S) ** kappa * bvn(-e2, -f2, rho)
            - (I1 / S) ** kappa * bvn(-e3, -f3, -rho)
            + (I1 / I2) ** kappa * bvn(-e4, -f4, -rho)
        )
    )


def _beta_and_boundaries(K, r, b, sigma):
    sig2 = sigma * sigma
    beta = (mp.mpf(1) / 2 - b / sig2) + mp.sqrt((b / sig2 - mp.mpf(1) / 2) ** 2 + 2 * r / sig2)
    b_inf = beta / (beta - 1) * K
    b0 = max(K, r / (r - b) * K)
    return beta, b_inf, b0


def bs1993_call(S, K, T, r, b, sigma):
    S, K, T, r, b, sigma = map(_mpf, (S, K, T, r, b, sigma))
    if b >= r:
        return european(True, S, K, T, r, b, sigma)
    beta, b_inf, b0 = _beta_and_boundaries(K, r, b, sigma)
    h = -(b * T + 2 * sigma * mp.sqrt(T)) * (b0 / (b_inf - b0))
    I = b0 + (b_inf - b0) * (1 - mp.exp(h))
    if S >= I:
        return S - K
    alpha = (I - K) * I ** (-beta)
    return (
        alpha * S**beta
        - alpha * phi(S, T, beta, I, I, r, b, sigma)
        + phi(S, T, 1, I, I, r, b, sigma)
        - phi(S, T, 1, K, I, r, b, sigma)
        - K * phi(S, T, 0, I, I, r, b, sigma)
        + K * phi(S, T, 0, K, I, r, b, sigma)
    )


def bs2002_call(S, K, T, r, b, sigma):
    S, K, T, r, b, sigma = map(_mpf, (S, K, T, r, b, sigma))
    if b >= r:
        return european(True, S, K, T, r, b, sigma)
    beta, b_inf, b0 = _beta_and_boundaries(K, r, b, sigma)
    t1 = (mp.sqrt(5) - 1) / 2 * T

    def boundary(t):
        h = -(b * t + 2 * sigma * mp.sqrt(t)) * (K * K / ((b_inf - b0) * b0))
        return b0 + (b_inf - b0) * (1 - mp.exp(h))

    I1, I2 = boundary(t1), boundary(T)
    if S >= I2:
        return S - K
    alpha1 = (I1 - K) * I1 ** (-beta)
    alpha2 = (I2 - K) * I2 ** (-beta)
    p = lambda gamma, H, I: phi(S, t1, gamma, H, I, r, b, sigma)  # noqa: E731
    q = lambda gamma, H: psi(S, T, gamma, H, I2, I1, t1, r, b, sigma)  # noqa: E731
    return (
        alpha2 * S**beta
        - alpha2 * p(beta, I2, I2)
        + p(1, I2, I2)
        - p(1, I1, I2)
        - K * p(0, I2, I2)
        + K * p(0, I1, I2)
        + alpha1 * p(beta, I1, I2)
        - alpha1 * q(beta, I1)
        + q(1, I1)
        - q(1, K)
        - K * q(0, I1)
        + K * q(0, K)
    )


def american_price(form, kind, S, K, T, r, q, sigma, floor=True):
    """Price an American `kind` option with the `form` ('2002' | '1993') approximation.

    `floor=True` applies TotalFinance's documented max(approximation, intrinsic, European) floor.
    """
    S, K, T, r, q, sigma = map(_mpf, (S, K, T, r, q, sigma))
    b = r - q
    call_form = bs2002_call if form == "2002" else bs1993_call
    if kind == "call":
        approximation = call_form(S, K, T, r, b, sigma)
    else:
        # P(S, K, T, r, b, σ) = C(K, S, T, r − b, −b, σ)
        approximation = call_form(K, S, T, r - b, -b, sigma)
    if not floor:
        return approximation
    return american_floor(kind, S, K, T, r, q, sigma, approximation)


def american_floor(kind, S, K, T, r, q, sigma, approximation):
    """TotalFinance's documented floor: max(approximation, intrinsic, European BSM)."""
    S, K, T, r, q, sigma = map(_mpf, (S, K, T, r, q, sigma))
    intrinsic = max(S - K, 0) if kind == "call" else max(K - S, 0)
    euro = european(kind == "call", S, K, T, r, r - q, sigma)
    return max(approximation, intrinsic, euro)


def self_check():
    """Reproduce the published S30QCF example and basic distribution identities."""
    published = american_price("2002", "call", 110, 100, 0.25, 0.08, 0.12, 0.2, floor=False)
    if abs(published - mp.mpf("10.3340")) > mp.mpf("0.00005"):
        raise AssertionError(f"S30QCF example: expected 10.3340, got {mp.nstr(published, 12)}")
    # M(a, ∞-ish, ρ) → N(a); M(0, 0, ρ) = ¼ + asin(ρ)/(2π).
    for rho in (mp.mpf("0.78615137775742328607"), mp.mpf("-0.78615137775742328607")):
        exact = mp.mpf(1) / 4 + mp.asin(rho) / (2 * mp.pi)
        if abs(bvn(0, 0, rho) - exact) > mp.mpf(10) ** -40:
            raise AssertionError(f"bvn(0, 0, {rho}) disagrees with the orthant identity")
    return published


if __name__ == "__main__":
    print("S30QCF example (published 10.3340):", mp.nstr(self_check(), 20))
