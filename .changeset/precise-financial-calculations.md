---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Repair numerical correctness in loans, IRR and composed returns, strategy break-evens, analytic option premiums, Kirk effective volatility, sample-centered GARCH, and Monte Carlo uncertainty. Singular covariance diagnostics now use null with a reason instead of infinite metadata. Clarify the existing HC1 correction in HAC documentation.

Supported call shapes and financial conventions are preserved. Unresolved analytic-premium cancellation and unrepresentable loan amortization receive explicit precision refusals. Loan schedules sum actual principal entries and reconcile only bounded arithmetic drift in the final installment. Positive Monte Carlo standard errors may accompany a null confidence interval when its endpoints cannot be represented around the estimate; this reporting limit does not change estimator convergence. Validate indefinite covariance before optimization, preserve term-relative IRR convergence and root ambiguity, and commit batch output buffers only after every row succeeds. Unavailable IV pricing trials report precision_limit instead of iteration exhaustion.
