# TotalFinance indicator warmup / lookahead / displacement

Warmup is the number of leading bars before the first real value, measured at the canonical parameters shown (via `indicator.explain(...).diagnostics.warmup`). 335 indicators.

**Lookahead: none.** Batch output is derived from a left-to-right stream, so no value depends on a future bar — causality is structural across the whole catalog.

**Displacement: none.** Each value is aligned to the bar it is computed on. Charting platforms plot some indicators shifted (Ichimoku's leading spans 26 bars ahead, the classic DPO shifted back); TotalFinance never plot-shifts — apply any display offset downstream.

## transform (14)

| Indicator           | Inputs | Warmup | Canonical parameters           |
| ------------------- | ------ | ------ | ------------------------------ |
| `averagePrice`      | bars   | 0      | —                              |
| `candleRange`       | bars   | 0      | —                              |
| `gap`               | bars   | 1      | —                              |
| `heikinAshi`        | bars   | 0      | —                              |
| `logReturns`        | series | 1      | —                              |
| `lowerShadow`       | bars   | 0      | —                              |
| `medianPrice`       | bars   | 0      | —                              |
| `realBody`          | bars   | 0      | —                              |
| `returns`           | series | 1      | —                              |
| `rollingVolatility` | series | 14     | `period=14, annualization=252` |
| `trueRange`         | bars   | 0      | —                              |
| `typicalPrice`      | bars   | 0      | —                              |
| `upperShadow`       | bars   | 0      | —                              |
| `weightedClose`     | bars   | 0      | —                              |

## moving-average (35)

| Indicator                 | Inputs | Warmup | Canonical parameters                                                |
| ------------------------- | ------ | ------ | ------------------------------------------------------------------- |
| `alma`                    | series | 13     | `period=14, offset=0.85, sigma=6`                                   |
| `anchoredVwap`            | bars   | 0      | `anchor=0`                                                          |
| `dema`                    | series | 26     | `period=14`                                                         |
| `ema`                     | series | 13     | `period=14`                                                         |
| `frama`                   | bars   | 13     | `period=14`                                                         |
| `fwma`                    | series | 13     | `period=14`                                                         |
| `gannHighLowActivator`    | bars   | 13     | `period=14`                                                         |
| `hma`                     | series | 16     | `period=14`                                                         |
| `holtWinterMovingAverage` | series | 0      | `levelSmoothing=0.2, trendSmoothing=0.1, accelerationSmoothing=0.1` |
| `jma`                     | series | 0      | `period=14, phase=0, power=1`                                       |
| `kama`                    | series | 14     | `period=14, fast=12, slow=26`                                       |
| `mama`                    | bars   | 6      | `fastLimit=0.5, slowLimit=0.05`                                     |
| `mcginley`                | series | 0      | `period=14`                                                         |
| `midpoint`                | series | 13     | `period=14`                                                         |
| `midprice`                | bars   | 13     | `period=14`                                                         |
| `movingAverage`           | series | 13     | `period=14, movingAverageType="ema"`                                |
| `movingAverageRibbon`     | series | 19     | `periods=[5,10,20]`                                                 |
| `pascalWma`               | series | 13     | `period=14`                                                         |
| `rainbowMovingAverage`    | series | 130    | `period=14, levels=10`                                              |
| `rma`                     | series | 13     | `period=14`                                                         |
| `rollingAnchoredVwap`     | bars   | 19     | `lookback=20, anchor="high"`                                        |
| `rollingVwap`             | bars   | 13     | `period=14`                                                         |
| `sessionVwap`             | bars   | 0      | `resetEvery=20`                                                     |
| `sineWma`                 | series | 13     | `period=14`                                                         |
| `sma`                     | series | 13     | `period=14`                                                         |
| `superSmoother`           | series | 0      | `period=14`                                                         |
| `symmetricWma`            | series | 13     | `period=14`                                                         |
| `t3`                      | series | 78     | `period=14, volumeFactor=0.7`                                       |
| `tema`                    | series | 39     | `period=14`                                                         |
| `trima`                   | series | 13     | `period=14`                                                         |
| `vidya`                   | series | 9      | `period=14, cmoPeriod=9`                                            |
| `vwapBands`               | bars   | 0      | `multiplier=2`                                                      |
| `vwma`                    | bars   | 13     | `period=14`                                                         |
| `wma`                     | series | 13     | `period=14`                                                         |
| `zlema`                   | series | 13     | `period=14`                                                         |

## momentum (54)

| Indicator              | Inputs | Warmup | Canonical parameters                                                                                                                                                                   |
| ---------------------- | ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apo`                  | series | 25     | `fast=12, slow=26`                                                                                                                                                                     |
| `awesomeOscillator`    | bars   | 25     | `fast=12, slow=26`                                                                                                                                                                     |
| `bias`                 | series | 13     | `period=14`                                                                                                                                                                            |
| `bop`                  | bars   | 0      | —                                                                                                                                                                                      |
| `brar`                 | bars   | 14     | `period=14`                                                                                                                                                                            |
| `cci`                  | bars   | 13     | `period=14`                                                                                                                                                                            |
| `centerOfGravity`      | series | 13     | `period=14`                                                                                                                                                                            |
| `cfo`                  | series | 13     | `period=14`                                                                                                                                                                            |
| `cmo`                  | series | 14     | `period=14, talib=false`                                                                                                                                                               |
| `connorsRsi`           | series | 101    | `rsiPeriod=14, streakPeriod=2, rankPeriod=100`                                                                                                                                         |
| `coppock`              | series | 23     | `longRoc=14, shortRoc=11, wma=10`                                                                                                                                                      |
| `cti`                  | series | 13     | `period=14`                                                                                                                                                                            |
| `dpo`                  | series | 13     | `period=14`                                                                                                                                                                            |
| `efficiencyRatio`      | series | 14     | `period=14`                                                                                                                                                                            |
| `elderRay`             | bars   | 13     | `period=14`                                                                                                                                                                            |
| `fisherTransform`      | bars   | 13     | `period=14`                                                                                                                                                                            |
| `forecastOscillator`   | series | 13     | `period=14`                                                                                                                                                                            |
| `inertia`              | series | 39     | `period=14, rviPeriod=14`                                                                                                                                                              |
| `kdj`                  | bars   | 13     | `period=14, signal=9`                                                                                                                                                                  |
| `kst`                  | series | 52     | `rocPeriods=[10,15,20,30], smaPeriods=[10,10,10,15], signal=9`                                                                                                                         |
| `laguerreRsi`          | series | 0      | `gamma=0.5`                                                                                                                                                                            |
| `macd`                 | series | 33     | `fast=12, slow=26, signal=9`                                                                                                                                                           |
| `macdExt`              | series | 33     | `fast=12, slow=26, signal=9, fastMovingAverageType="ema", slowMovingAverageType="ema", signalMovingAverageType="ema"`                                                                  |
| `macdFix`              | series | 33     | `signal=9`                                                                                                                                                                             |
| `momentum`             | series | 14     | `period=14`                                                                                                                                                                            |
| `pgo`                  | bars   | 13     | `period=14`                                                                                                                                                                            |
| `ppo`                  | series | 33     | `fast=12, slow=26, signal=9`                                                                                                                                                           |
| `projectionOscillator` | bars   | 13     | `period=14`                                                                                                                                                                            |
| `psychologicalLine`    | series | 14     | `period=14`                                                                                                                                                                            |
| `pvo`                  | bars   | 33     | `fast=12, slow=26, signal=9`                                                                                                                                                           |
| `qqe`                  | series | 71     | `rsiPeriod=14, smooth=5, factor=4.236`                                                                                                                                                 |
| `relativeVigorIndex`   | bars   | 19     | `period=14`                                                                                                                                                                            |
| `roc`                  | series | 14     | `period=14`                                                                                                                                                                            |
| `rocp`                 | series | 14     | `period=14`                                                                                                                                                                            |
| `rocr`                 | series | 14     | `period=14`                                                                                                                                                                            |
| `rocr100`              | series | 14     | `period=14`                                                                                                                                                                            |
| `rsi`                  | series | 14     | `period=14`                                                                                                                                                                            |
| `rsx`                  | series | 14     | `period=14`                                                                                                                                                                            |
| `schaffTrendCycle`     | series | 43     | `fast=12, slow=26, cycle=10`                                                                                                                                                           |
| `slope`                | series | 14     | `period=14`                                                                                                                                                                            |
| `smcSweep`             | bars   | 0      | `period=14, wickMultiplier=1.5`                                                                                                                                                        |
| `smiErgodic`           | series | 45     | `long=25, short=13, signal=9`                                                                                                                                                          |
| `squeeze`              | bars   | 38     | `bollingerBandPeriod=20, bollingerStandardDeviations=2, keltnerChannelPeriod=20, keltnerChannelMultiplier=1.5`                                                                         |
| `squeezePro`           | bars   | 38     | `bollingerBandPeriod=20, bollingerStandardDeviations=2, keltnerChannelPeriod=20, wideKeltnerChannelMultiplier=2, normalKeltnerChannelMultiplier=1.5, narrowKeltnerChannelMultiplier=1` |
| `stochastic`           | bars   | 15     | `kPeriod=14, dPeriod=3, smoothK=1`                                                                                                                                                     |
| `stochFast`            | bars   | 15     | `kPeriod=14, dPeriod=3, smoothK=1`                                                                                                                                                     |
| `stochRsi`             | series | 42     | `rsiPeriod=14, stochPeriod=14, kPeriod=14, dPeriod=3`                                                                                                                                  |
| `tdSequential`         | bars   | 20     | `lookback=20`                                                                                                                                                                          |
| `trix`                 | series | 40     | `period=14`                                                                                                                                                                            |
| `trixHistogram`        | series | 48     | `period=14, signal=9`                                                                                                                                                                  |
| `tsi`                  | series | 45     | `long=25, short=13, signal=9`                                                                                                                                                          |
| `ultimateOscillator`   | bars   | 25     | `short=13, medium=14, long=25`                                                                                                                                                         |
| `volumeWeightedMacd`   | bars   | 33     | `fast=12, slow=26, signal=9`                                                                                                                                                           |
| `williamsR`            | bars   | 13     | `period=14`                                                                                                                                                                            |

## trend (38)

| Indicator                  | Inputs | Warmup | Canonical parameters                                                                                                                             |
| -------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adx`                      | bars   | 27     | `period=14`                                                                                                                                      |
| `adxr`                     | bars   | 41     | `period=14`                                                                                                                                      |
| `amat`                     | series | 45     | `fast=12, slow=26, lookback=20, movingAverageType="ema"`                                                                                         |
| `aroon`                    | bars   | 14     | `period=14`                                                                                                                                      |
| `aroonOscillator`          | bars   | 14     | `period=14`                                                                                                                                      |
| `centralPivotRange`        | bars   | 1      | —                                                                                                                                                |
| `chandeKrollStop`          | bars   | 26     | `atrPeriod=14, multiplier=2, period=14`                                                                                                          |
| `chandelierExit`           | bars   | 13     | `period=14, multiplier=2`                                                                                                                        |
| `choppinessIndex`          | bars   | 13     | `period=14`                                                                                                                                      |
| `crossSignals`             | series | 1      | `above=0, below=0`                                                                                                                               |
| `decreasing`               | series | 14     | `period=14, strict=false`                                                                                                                        |
| `dmi`                      | bars   | 14     | `period=14`                                                                                                                                      |
| `donchianTrend`            | bars   | 13     | `period=14`                                                                                                                                      |
| `dx`                       | bars   | 14     | `period=14`                                                                                                                                      |
| `exponentialDecay`         | series | 0      | `period=14`                                                                                                                                      |
| `ichimoku`                 | bars   | 51     | `conversion=9, base=26, spanB=52, displacement=26`                                                                                               |
| `increasing`               | series | 14     | `period=14, strict=false`                                                                                                                        |
| `linearDecay`              | series | 0      | `period=14`                                                                                                                                      |
| `linreg`                   | series | 13     | `period=14`                                                                                                                                      |
| `linregAngle`              | series | 13     | `period=14`                                                                                                                                      |
| `linregIntercept`          | series | 13     | `period=14`                                                                                                                                      |
| `linregSlope`              | series | 13     | `period=14`                                                                                                                                      |
| `longRun`                  | pair   | 14     | `period=14`                                                                                                                                      |
| `minusDI`                  | bars   | 14     | `period=14`                                                                                                                                      |
| `minusDM`                  | bars   | 14     | `period=14`                                                                                                                                      |
| `plusDI`                   | bars   | 14     | `period=14`                                                                                                                                      |
| `plusDM`                   | bars   | 14     | `period=14`                                                                                                                                      |
| `pMax`                     | bars   | 13     | `period=14, multiplier=2`                                                                                                                        |
| `psar`                     | bars   | 1      | `step=0.02, max=0.2`                                                                                                                             |
| `psarExt`                  | bars   | 1      | `startValue=0, offsetOnReverse=0, accelInitLong=0.02, accelLong=0.02, accelMaxLong=0.2, accelInitShort=0.02, accelShort=0.02, accelMaxShort=0.2` |
| `qstick`                   | bars   | 13     | `period=14`                                                                                                                                      |
| `shortRun`                 | pair   | 14     | `period=14`                                                                                                                                      |
| `supertrend`               | bars   | 13     | `period=14, multiplier=2`                                                                                                                        |
| `trendSignals`             | series | 0      | —                                                                                                                                                |
| `tsf`                      | series | 13     | `period=14`                                                                                                                                      |
| `ttmTrend`                 | bars   | 13     | `period=14`                                                                                                                                      |
| `verticalHorizontalFilter` | series | 14     | `period=14`                                                                                                                                      |
| `vortex`                   | bars   | 14     | `period=14`                                                                                                                                      |

## volatility (27)

| Indicator                 | Inputs | Warmup | Canonical parameters                                                                                 |
| ------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------- |
| `aberration`              | bars   | 13     | `period=14, atrPeriod=14`                                                                            |
| `accelerationBands`       | bars   | 13     | `period=14, multiplier=2`                                                                            |
| `atr`                     | bars   | 13     | `period=14`                                                                                          |
| `atrBands`                | bars   | 13     | `period=14, multiplier=2`                                                                            |
| `bbands`                  | series | 13     | `period=14, standardDeviation=2`                                                                     |
| `bollingerBandWidth`      | series | 13     | `period=14, standardDeviation=2`                                                                     |
| `bollingerPercentB`       | series | 13     | `period=14, standardDeviation=2`                                                                     |
| `chaikinVolatility`       | bars   | 23     | `period=14, rocPeriod=10`                                                                            |
| `donchian`                | bars   | 13     | `period=14`                                                                                          |
| `elderThermometer`        | bars   | 14     | `period=14, long=25, short=13`                                                                       |
| `garmanKlass`             | bars   | 13     | `period=14, annualization=252`                                                                       |
| `historicalVolatility`    | series | 14     | `period=14, annualization=252`                                                                       |
| `holtWinterChannel`       | series | 0      | `levelSmoothing=0.2, trendSmoothing=0.1, accelerationSmoothing=0.1, varianceSmoothing=0.1, scalar=1` |
| `keltner`                 | bars   | 13     | `period=14, atrPeriod=14, multiplier=2`                                                              |
| `massIndex`               | bars   | 47     | `fast=12, slow=26`                                                                                   |
| `natr`                    | bars   | 13     | `period=14`                                                                                          |
| `parkinson`               | bars   | 13     | `period=14, annualization=252`                                                                       |
| `percentAtr`              | bars   | 13     | `period=14`                                                                                          |
| `priceDistance`           | bars   | 1      | `drift=1`                                                                                            |
| `realizedVolatility`      | series | 14     | `period=14, annualization=252`                                                                       |
| `relativeVolatilityIndex` | series | 26     | `period=14, stdevPeriod=14`                                                                          |
| `rogersSatchell`          | bars   | 13     | `period=14, annualization=252`                                                                       |
| `standardDeviation`       | series | 13     | `period=14, sample=true`                                                                             |
| `ulcerIndex`              | series | 26     | `period=14`                                                                                          |
| `variance`                | series | 13     | `period=14, sample=true`                                                                             |
| `volatilityStop`          | bars   | 13     | `period=14, multiplier=2`                                                                            |
| `yangZhang`               | bars   | 14     | `period=14, annualization=252`                                                                       |

## volume (24)

| Indicator                 | Inputs | Warmup | Canonical parameters                                     |
| ------------------------- | ------ | ------ | -------------------------------------------------------- |
| `adLine`                  | bars   | 0      | —                                                        |
| `archerObv`               | bars   | 27     | `fast=12, slow=26, runLength=2`                          |
| `chaikinMoneyFlow`        | bars   | 13     | `period=14`                                              |
| `chaikinOscillator`       | bars   | 25     | `fast=12, slow=26`                                       |
| `cvd`                     | bars   | 0      | —                                                        |
| `easeOfMovement`          | bars   | 14     | `period=14, scale=10000`                                 |
| `efi`                     | bars   | 14     | `period=14`                                              |
| `emv`                     | bars   | 14     | `period=14, scale=10000`                                 |
| `forceIndex`              | bars   | 14     | `period=14`                                              |
| `klinger`                 | bars   | 34     | `fast=12, slow=26, signal=9`                             |
| `kvo`                     | bars   | 34     | `fast=12, slow=26, signal=9`                             |
| `marketFacilitationIndex` | bars   | 0      | —                                                        |
| `mfi`                     | bars   | 14     | `period=14`                                              |
| `nvi`                     | bars   | 0      | —                                                        |
| `obv`                     | bars   | 0      | `talib=false`                                            |
| `priceVolume`             | bars   | 0      | `signed=false`                                           |
| `priceVolumeRank`         | bars   | 1      | —                                                        |
| `pvi`                     | bars   | 0      | —                                                        |
| `pvt`                     | bars   | 0      | —                                                        |
| `relativeVolume`          | bars   | 13     | `period=14`                                              |
| `vfi`                     | bars   | 18     | `period=14, coefficient=0.2, volumeCutoff=2.5, smooth=5` |
| `volumeOscillator`        | bars   | 25     | `fast=12, slow=26`                                       |
| `vwap`                    | bars   | 0      | —                                                        |
| `williamsAd`              | bars   | 0      | —                                                        |

## cycle (9)

| Indicator     | Inputs | Warmup | Canonical parameters |
| ------------- | ------ | ------ | -------------------- |
| `dsp`         | series | 13     | `period=14`          |
| `ebsw`        | series | 39     | `period=40, bars=10` |
| `htDcPeriod`  | series | 6      | —                    |
| `htDcPhase`   | series | 6      | —                    |
| `htPhasor`    | series | 6      | —                    |
| `htSine`      | series | 6      | —                    |
| `htTrendline` | series | 6      | —                    |
| `htTrendMode` | series | 6      | —                    |
| `msw`         | series | 14     | `period=14`          |

## math (21)

| Indicator   | Inputs | Warmup | Canonical parameters |
| ----------- | ------ | ------ | -------------------- |
| `acos`      | series | 0      | —                    |
| `add`       | pair   | 0      | —                    |
| `asin`      | series | 0      | —                    |
| `atan`      | series | 0      | —                    |
| `ceil`      | series | 0      | —                    |
| `cos`       | series | 0      | —                    |
| `cosh`      | series | 0      | —                    |
| `crossany`  | pair   | 0      | —                    |
| `crossover` | pair   | 0      | —                    |
| `div`       | pair   | 0      | —                    |
| `exp`       | series | 0      | —                    |
| `floor`     | series | 0      | —                    |
| `ln`        | series | 0      | —                    |
| `log10`     | series | 0      | —                    |
| `mult`      | pair   | 0      | —                    |
| `sin`       | series | 0      | —                    |
| `sinh`      | series | 0      | —                    |
| `sqrt`      | series | 0      | —                    |
| `sub`       | pair   | 0      | —                    |
| `tan`       | series | 0      | —                    |
| `tanh`      | series | 0      | —                    |

## performance (1)

| Indicator  | Inputs | Warmup | Canonical parameters |
| ---------- | ------ | ------ | -------------------- |
| `drawdown` | series | 0      | —                    |

## statistic (39)

| Indicator            | Inputs | Warmup | Canonical parameters                |
| -------------------- | ------ | ------ | ----------------------------------- |
| `barSince`           | series | 0      | —                                   |
| `beta`               | pair   | 14     | `period=14`                         |
| `change`             | series | 14     | `period=14`                         |
| `correl`             | pair   | 13     | `period=14`                         |
| `covariance`         | pair   | 13     | `period=14, sample=true`            |
| `cum`                | series | 0      | —                                   |
| `diff`               | series | 14     | `period=14`                         |
| `entropy`            | series | 13     | `period=14`                         |
| `fractionalChange`   | series | 14     | `period=14`                         |
| `highestBars`        | series | 13     | `period=14`                         |
| `kurtosis`           | series | 13     | `period=14`                         |
| `lag`                | series | 14     | `period=14`                         |
| `lowestBars`         | series | 13     | `period=14`                         |
| `mad`                | series | 13     | `period=14`                         |
| `normalize`          | series | 13     | `period=14`                         |
| `percentRank`        | series | 13     | `period=14`                         |
| `rescale`            | series | 13     | `period=14, min=0, max=0.2`         |
| `rollingBeta`        | pair   | 14     | `period=14`                         |
| `rollingCorrelation` | pair   | 13     | `period=14`                         |
| `rollingMax`         | series | 13     | `period=14`                         |
| `rollingMaxIndex`    | series | 13     | `period=14`                         |
| `rollingMean`        | series | 13     | `period=14`                         |
| `rollingMedian`      | series | 13     | `period=14`                         |
| `rollingMin`         | series | 13     | `period=14`                         |
| `rollingMinIndex`    | series | 13     | `period=14`                         |
| `rollingMinMax`      | series | 13     | `period=14`                         |
| `rollingMinMaxIndex` | series | 13     | `period=14`                         |
| `rollingQuantile`    | series | 13     | `period=14, quantile=0.5`           |
| `rollingRank`        | series | 13     | `period=14`                         |
| `rollingRegression`  | pair   | 13     | `period=14`                         |
| `rollingSum`         | series | 13     | `period=14`                         |
| `rSquared`           | pair   | 13     | `period=14`                         |
| `shift`              | series | 14     | `period=14`                         |
| `skew`               | series | 13     | `period=14`                         |
| `standardError`      | series | 13     | `period=14`                         |
| `tosStdevAll`        | series | 13     | `period=14, stds=[1,2,3], ddof=1`   |
| `valueWhen`          | pair   | 0      | `occurrence=0`                      |
| `winsorize`          | series | 13     | `period=14, lower=0.05, upper=0.95` |
| `zScore`             | series | 13     | `period=14`                         |

## candlestick (65)

| Indicator              | Inputs | Warmup | Canonical parameters |
| ---------------------- | ------ | ------ | -------------------- |
| `abandonedBaby`        | bars   | 12     | —                    |
| `advanceBlock`         | bars   | 12     | —                    |
| `beltHold`             | bars   | 10     | —                    |
| `breakaway`            | bars   | 14     | —                    |
| `cdlDoji`              | bars   | 10     | —                    |
| `cdlInside`            | bars   | 11     | —                    |
| `cdlZ`                 | bars   | 13     | `period=14, ddof=1`  |
| `closingMarubozu`      | bars   | 10     | —                    |
| `concealBabySwallow`   | bars   | 13     | —                    |
| `counterattack`        | bars   | 11     | —                    |
| `darkCloudCover`       | bars   | 11     | —                    |
| `doji`                 | bars   | 10     | —                    |
| `dojiStar`             | bars   | 11     | —                    |
| `dragonflyDoji`        | bars   | 10     | —                    |
| `engulfing`            | bars   | 11     | —                    |
| `eveningDojiStar`      | bars   | 12     | —                    |
| `eveningStar`          | bars   | 12     | —                    |
| `gapSideSideWhite`     | bars   | 12     | —                    |
| `gravestoneDoji`       | bars   | 10     | —                    |
| `hammer`               | bars   | 10     | —                    |
| `hangingMan`           | bars   | 10     | —                    |
| `harami`               | bars   | 11     | —                    |
| `haramiCross`          | bars   | 11     | —                    |
| `highWave`             | bars   | 10     | —                    |
| `hikkake`              | bars   | 12     | —                    |
| `hikkakeMod`           | bars   | 12     | —                    |
| `homingPigeon`         | bars   | 11     | —                    |
| `identicalThreeCrows`  | bars   | 12     | —                    |
| `inNeck`               | bars   | 11     | —                    |
| `inside`               | bars   | 11     | —                    |
| `invertedHammer`       | bars   | 10     | —                    |
| `kicking`              | bars   | 11     | —                    |
| `kickingByLength`      | bars   | 11     | —                    |
| `ladderBottom`         | bars   | 14     | —                    |
| `longLeggedDoji`       | bars   | 10     | —                    |
| `longLine`             | bars   | 10     | —                    |
| `marubozu`             | bars   | 10     | —                    |
| `matchingLow`          | bars   | 11     | —                    |
| `matHold`              | bars   | 14     | —                    |
| `morningDojiStar`      | bars   | 12     | —                    |
| `morningStar`          | bars   | 12     | —                    |
| `onNeck`               | bars   | 11     | —                    |
| `piercing`             | bars   | 11     | —                    |
| `rickshawMan`          | bars   | 10     | —                    |
| `riseFallThreeMethods` | bars   | 14     | —                    |
| `separatingLines`      | bars   | 11     | —                    |
| `shootingStar`         | bars   | 10     | —                    |
| `shortLine`            | bars   | 10     | —                    |
| `spinningTop`          | bars   | 10     | —                    |
| `stalledPattern`       | bars   | 12     | —                    |
| `stickSandwich`        | bars   | 12     | —                    |
| `takuri`               | bars   | 10     | —                    |
| `tasukiGap`            | bars   | 12     | —                    |
| `threeBlackCrows`      | bars   | 12     | —                    |
| `threeInside`          | bars   | 12     | —                    |
| `threeLineStrike`      | bars   | 13     | —                    |
| `threeOutside`         | bars   | 12     | —                    |
| `threeStarsInSouth`    | bars   | 12     | —                    |
| `threeWhiteSoldiers`   | bars   | 12     | —                    |
| `thrusting`            | bars   | 11     | —                    |
| `triStar`              | bars   | 12     | —                    |
| `twoCrows`             | bars   | 12     | —                    |
| `uniqueThreeRiver`     | bars   | 12     | —                    |
| `upsideGapTwoCrows`    | bars   | 12     | —                    |
| `xSideGapThreeMethods` | bars   | 12     | —                    |

## price-action (8)

| Indicator           | Inputs | Warmup | Canonical parameters                                                                      |
| ------------------- | ------ | ------ | ----------------------------------------------------------------------------------------- |
| `atrTrailingStop`   | bars   | 13     | `period=14, multiplier=2`                                                                 |
| `divergence`        | pair   | 10     | `swing={"left":5,"right":5}, kinds=["bullish","bearish","hiddenBullish","hiddenBearish"]` |
| `equalHighs`        | bars   | 4      | `strength=2, tolerance=0.001`                                                             |
| `equalLows`         | bars   | 4      | `strength=2, tolerance=0.001`                                                             |
| `fairValueGaps`     | bars   | 2      | `minimumGapPercent=0`                                                                     |
| `liquiditySweeps`   | bars   | 20     | `lookback=20`                                                                             |
| `orderBlocks`       | bars   | 0      | `lookback=20`                                                                             |
| `swingTrailingStop` | bars   | 10     | `strength=2`                                                                              |
