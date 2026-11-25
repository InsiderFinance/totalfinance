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

The finite-difference Greeks of the American engines now use scale-aware default bumps. Each is the
previous reference bump, capped at a hundredth of its coordinate's natural scale: S·σ√T for spot, σ for
volatility, T for time, and σ/√T for rate and carry. So a bump changes only for a narrow
distribution: spot when σ√T < 0.1, volatility when σ < 10%, time when T < 0.01 years, rate when
σ/√T < 0.01. Short-expiry and low-volatility Greeks are now resolved. A one-day, 1%-vol at-the-money
call previously reported delta 6.4% low and gamma 21% low; it is now within 1e-5 of the analytic
values. Where a stencil would straddle the early-exercise switch, the engines difference one-sided on
the branch holding the base point, so an exercised contract reports delta ±1 and zero gamma, vega,
theta and rho. Units and explicit step controls are unchanged, and the bumps used are disclosed in
`diagnostics.finiteDifferenceBumps`. Monte-Carlo Greeks keep their previous bumps.

The finite-difference engines also refuse a non-finite Greek with `postcondition.non_finite_result`
instead of returning it silently. The American implied-volatility inversion no longer computes unused
Greeks while repricing.
