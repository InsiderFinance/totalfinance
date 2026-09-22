# Option pricing formula reference

All three models are European closed-form. `Φ` is the standard normal CDF, `φ` the PDF. Greeks are
reported in TotalFinance default units (theta per day, vega per 1% for BSM/Black-76, rho per 1%); the
applied units are always echoed in `assumptions.units`.

## Black–Scholes–Merton (`@insiderfinance/totalfinance/options/black-scholes`)

Spot `S`, strike `K`, time `T` (years), rate `r`, dividend yield `q`, volatility `σ`.

```
d1 = [ln(S/K) + (r − q + σ²/2)·T] / (σ·√T)
d2 = d1 − σ·√T

call = S·e^{−qT}·Φ(d1) − K·e^{−rT}·Φ(d2)
put  = K·e^{−rT}·Φ(−d2) − S·e^{−qT}·Φ(−d1)
```

Greeks (call; put analogous):

```
delta = e^{−qT}·Φ(d1)
gamma = e^{−qT}·φ(d1) / (S·σ·√T)
vega  = S·e^{−qT}·φ(d1)·√T            (reported ÷100, per 1% of σ)
theta = −S·e^{−qT}·φ(d1)·σ/(2√T) − r·K·e^{−rT}·Φ(d2) + q·S·e^{−qT}·Φ(d1)   (reported ÷365, per day)
rho   = K·T·e^{−rT}·Φ(d2)            (reported ÷100, per 1% of r)
```

Reference: a 1-year ATM call with `S=K=100, r=5%, σ=20%, q=0` prices to **10.4506**.

## Black-76 (`@insiderfinance/totalfinance/options/black76`)

Options on a forward/futures price `F`; discounting at `r`.

```
d1 = [ln(F/K) + σ²/2·T] / (σ·√T)
d2 = d1 − σ·√T

call = e^{−rT}·[F·Φ(d1) − K·Φ(d2)]
put  = e^{−rT}·[K·Φ(−d2) − F·Φ(−d1)]

delta = e^{−rT}·Φ(d1)                 (w.r.t. the forward)
gamma = e^{−rT}·φ(d1) / (F·σ·√T)
vega  = F·e^{−rT}·φ(d1)·√T            (÷100)
theta = r·price − F·e^{−rT}·φ(d1)·σ/(2√T)   (÷365)
rho   = −T·price                      (÷100; F fixed, only discounting depends on r)
```

Put–call parity: `C − P = e^{−rT}·(F − K)`.

## Bachelier / normal (`@insiderfinance/totalfinance/options/bachelier`)

Arithmetic Brownian motion on the forward; `σ_N` is a **normal** vol in price units. Vega is reported
per 1.00 of normal vol (`assumptions.units.vega = "perPoint"`).

```
d = (F − K) / (σ_N·√T)

call = e^{−rT}·[(F − K)·Φ(d) + σ_N·√T·φ(d)]
put  = e^{−rT}·[(K − F)·Φ(−d) + σ_N·√T·φ(d)]

delta = e^{−rT}·Φ(d)
gamma = e^{−rT}·φ(d) / (σ_N·√T)
vega  = e^{−rT}·√T·φ(d)              (per 1.00 of σ_N)
theta = r·price − e^{−rT}·σ_N·φ(d)/(2√T)   (÷365)
rho   = −T·price                      (÷100)
```

An ATM call (`F=K`, `r=0`) prices to `σ_N·√T·φ(0) = σ_N·√T/√(2π)`.

## Implied volatility

All three solve IV with Brent on a bracketed interval, with no-arbitrage bound checks first. A price
below intrinsic or above the upper bound, or a non-converged solve, is reported honestly
(`converged: false` from `.explain()`, a thrown `ArbitrageError`/`ConvergenceError` from the facade)
— never a fabricated value (design law #4). Prices numerically at a no-arbitrage bound resolve to the
bracket-endpoint vol within the solver's price tolerance.
