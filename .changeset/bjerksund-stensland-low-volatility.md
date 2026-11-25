---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Fix the Bjerksund–Stensland American approximations (2002, its `bjerksundStensland()` alias, and
1993). For valid low-volatility inputs they returned a NaN price, which the no-arbitrage postcondition
refused, or a NaN Greek. The cause was a reflection power `(I/S)^κ` that overflowed while its matching
normal tail underflowed. The published formulas are now evaluated in the log domain with
cancellation-free, scale-free boundary algebra. Every previously failing case now prices to the exact
model value, ordinary results are unchanged to rounding, and very large and very small monetary scales
work. The model, floor and result shapes are unchanged.

The finite-difference Greeks of the closed-form American approximations (Barone–Adesi–Whaley and
Bjerksund–Stensland), and the European digital's extended Greeks, now use scale-aware default bumps.
Each is the previous reference bump, capped at a hundredth of its coordinate's natural scale: S·σ√T for
spot, σ for volatility, T for time, and σ/√T for rate and carry. So a bump changes only for a narrow
distribution: spot when σ√T < 0.1, volatility when σ < 10%, time when T < 0.01 years, and rate when
σ/√T < 0.01. For these engines a one-day, 1%-vol at-the-money call previously reported delta 6.4%
low and gamma 21% low; it is now within 1e-5 of the analytic values. Next to the exercise boundary,
the one-sided stencils described below are less accurate (up to about 4e-4 of a normalized Greek at
one day and 1% vol).

Lattice, Crank–Nicolson, Monte-Carlo, SABR and Heston Greeks keep their previous bumps. Discretized
prices have node-level kinks that a finer bump would difference, and Monte-Carlo differences are
variance-limited, so at very short expiry and low volatility those Greeks stay resolution- or
variance-limited as before. Where a stencil would straddle the early-exercise switch, every American engine now
differences one-sided on the branch holding the base point. An exercised contract therefore reports
delta ±1 and zero gamma, vega, theta and rho, and some Jarrow–Rudd and Tian rho values change for this
reason. Units and explicit step controls are unchanged, and the bumps used are disclosed in
`diagnostics.finiteDifferenceBumps`.

The finite-difference engines also refuse a non-finite Greek with `postcondition.non_finite_result`
instead of returning it silently. The American implied-volatility inversion no longer computes unused
Greeks while repricing.
