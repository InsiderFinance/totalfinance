# TotalFinance indicator registry

Auto-generated from `@insiderfinance/totalfinance/technical-analysis` — 335 registered indicators.

## transform (14)

| Indicator           | Inputs | Parameters                | Output                         |
| ------------------- | ------ | ------------------------- | ------------------------------ |
| `averagePrice`      | bars   | —                         | number                         |
| `candleRange`       | bars   | —                         | number                         |
| `gap`               | bars   | —                         | number                         |
| `heikinAshi`        | bars   | —                         | record{close, high, low, open} |
| `logReturns`        | series | —                         | number                         |
| `lowerShadow`       | bars   | —                         | number                         |
| `medianPrice`       | bars   | —                         | number                         |
| `realBody`          | bars   | —                         | number                         |
| `returns`           | series | —                         | number                         |
| `rollingVolatility` | series | `period`, `annualization` | number                         |
| `trueRange`         | bars   | —                         | number                         |
| `typicalPrice`      | bars   | —                         | number                         |
| `upperShadow`       | bars   | —                         | number                         |
| `weightedClose`     | bars   | —                         | number                         |

## moving-average (35)

| Indicator                 | Inputs | Parameters                                                  | Output                      |
| ------------------------- | ------ | ----------------------------------------------------------- | --------------------------- |
| `alma`                    | series | `period`, `offset`, `sigma`                                 | number                      |
| `anchoredVwap`            | bars   | `anchor`                                                    | number                      |
| `dema`                    | series | `period`                                                    | number                      |
| `ema`                     | series | `period`                                                    | number                      |
| `frama`                   | bars   | `period`                                                    | number                      |
| `fwma`                    | series | `period`                                                    | number                      |
| `gannHighLowActivator`    | bars   | `period`                                                    | record{trend, value}        |
| `hma`                     | series | `period`                                                    | number                      |
| `holtWinterMovingAverage` | series | `levelSmoothing`, `trendSmoothing`, `accelerationSmoothing` | number                      |
| `jma`                     | series | `period`, `phase`, `power`                                  | number                      |
| `kama`                    | series | `period`, `fast`, `slow`                                    | number                      |
| `mama`                    | bars   | `fastLimit`, `slowLimit`                                    | record{fama, mama}          |
| `mcginley`                | series | `period`                                                    | number                      |
| `midpoint`                | series | `period`                                                    | number                      |
| `midprice`                | bars   | `period`                                                    | number                      |
| `movingAverage`           | series | `period`, `movingAverageType`                               | number                      |
| `movingAverageRibbon`     | series | `periods`                                                   | number[]                    |
| `pascalWma`               | series | `period`                                                    | number                      |
| `rainbowMovingAverage`    | series | `period`, `levels`                                          | number                      |
| `rma`                     | series | `period`                                                    | number                      |
| `rollingAnchoredVwap`     | bars   | `lookback`, `anchor`                                        | record{anchorBarsAgo, vwap} |
| `rollingVwap`             | bars   | `period`                                                    | number                      |
| `sessionVwap`             | bars   | `resetEvery`                                                | number                      |
| `sineWma`                 | series | `period`                                                    | number                      |
| `sma`                     | series | `period`                                                    | number                      |
| `superSmoother`           | series | `period`                                                    | number                      |
| `symmetricWma`            | series | `period`                                                    | number                      |
| `t3`                      | series | `period`, `volumeFactor`                                    | number                      |
| `tema`                    | series | `period`                                                    | number                      |
| `trima`                   | series | `period`                                                    | number                      |
| `vidya`                   | series | `period`, `cmoPeriod`                                       | number                      |
| `vwapBands`               | bars   | `multiplier`                                                | record{lower, upper, vwap}  |
| `vwma`                    | bars   | `period`                                                    | number                      |
| `wma`                     | series | `period`                                                    | number                      |
| `zlema`                   | series | `period`                                                    | number                      |

## momentum (54)

| Indicator              | Inputs | Parameters                                                                                                                                                                       | Output                                                               |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apo`                  | series | `fast`, `slow`                                                                                                                                                                   | number                                                               |
| `awesomeOscillator`    | bars   | `fast`, `slow`                                                                                                                                                                   | number                                                               |
| `bias`                 | series | `period`                                                                                                                                                                         | number                                                               |
| `bop`                  | bars   | —                                                                                                                                                                                | number                                                               |
| `brar`                 | bars   | `period`                                                                                                                                                                         | record{popularityIndex, willingnessIndex}                            |
| `cci`                  | bars   | `period`                                                                                                                                                                         | number                                                               |
| `centerOfGravity`      | series | `period`                                                                                                                                                                         | number                                                               |
| `cfo`                  | series | `period`                                                                                                                                                                         | number                                                               |
| `cmo`                  | series | `period`, `talib`                                                                                                                                                                | number                                                               |
| `connorsRsi`           | series | `rsiPeriod`, `streakPeriod`, `rankPeriod`                                                                                                                                        | number                                                               |
| `coppock`              | series | `longRoc`, `shortRoc`, `wma`                                                                                                                                                     | number                                                               |
| `cti`                  | series | `period`                                                                                                                                                                         | number                                                               |
| `dpo`                  | series | `period`                                                                                                                                                                         | number                                                               |
| `efficiencyRatio`      | series | `period`                                                                                                                                                                         | number                                                               |
| `elderRay`             | bars   | `period`                                                                                                                                                                         | record{bear, bull}                                                   |
| `fisherTransform`      | bars   | `period`                                                                                                                                                                         | record{fisher, trigger}                                              |
| `forecastOscillator`   | series | `period`                                                                                                                                                                         | number                                                               |
| `inertia`              | series | `period`, `rviPeriod`                                                                                                                                                            | number                                                               |
| `kdj`                  | bars   | `period`, `signal`                                                                                                                                                               | record{d, j, k}                                                      |
| `kst`                  | series | `rocPeriods`, `smaPeriods`, `signal`                                                                                                                                             | record{kst, signal}                                                  |
| `laguerreRsi`          | series | `gamma`                                                                                                                                                                          | number                                                               |
| `macd`                 | series | `fast`, `slow`, `signal`                                                                                                                                                         | record{histogram, macd, signal}                                      |
| `macdExt`              | series | `fast`, `slow`, `signal`, `fastMovingAverageType`, `slowMovingAverageType`, `signalMovingAverageType`                                                                            | record{histogram, macd, signal}                                      |
| `macdFix`              | series | `signal`                                                                                                                                                                         | record{histogram, macd, signal}                                      |
| `momentum`             | series | `period`                                                                                                                                                                         | number                                                               |
| `pgo`                  | bars   | `period`                                                                                                                                                                         | number                                                               |
| `ppo`                  | series | `fast`, `slow`, `signal`                                                                                                                                                         | record{histogram, ppo, signal}                                       |
| `projectionOscillator` | bars   | `period`                                                                                                                                                                         | record{lower, po, upper}                                             |
| `psychologicalLine`    | series | `period`                                                                                                                                                                         | number                                                               |
| `pvo`                  | bars   | `fast`, `slow`, `signal`                                                                                                                                                         | record{histogram, pvo, signal}                                       |
| `qqe`                  | series | `rsiPeriod`, `smooth`, `factor`                                                                                                                                                  | record{longBand, rsiMovingAverage, shortBand}                        |
| `relativeVigorIndex`   | bars   | `period`                                                                                                                                                                         | record{rvi, signal}                                                  |
| `roc`                  | series | `period`                                                                                                                                                                         | number                                                               |
| `rocp`                 | series | `period`                                                                                                                                                                         | number                                                               |
| `rocr`                 | series | `period`                                                                                                                                                                         | number                                                               |
| `rocr100`              | series | `period`                                                                                                                                                                         | number                                                               |
| `rsi`                  | series | `period`                                                                                                                                                                         | number                                                               |
| `rsx`                  | series | `period`                                                                                                                                                                         | number                                                               |
| `schaffTrendCycle`     | series | `fast`, `slow`, `cycle`                                                                                                                                                          | number                                                               |
| `slope`                | series | `period`                                                                                                                                                                         | number                                                               |
| `smcSweep`             | bars   | `period`, `wickMultiplier`                                                                                                                                                       | number                                                               |
| `smiErgodic`           | series | `long`, `short`, `signal`                                                                                                                                                        | record{oscillator, signal, smi}                                      |
| `squeeze`              | bars   | `bollingerBandPeriod`, `bollingerStandardDeviations`, `keltnerChannelPeriod`, `keltnerChannelMultiplier`                                                                         | record{momentum, on}                                                 |
| `squeezePro`           | bars   | `bollingerBandPeriod`, `bollingerStandardDeviations`, `keltnerChannelPeriod`, `wideKeltnerChannelMultiplier`, `normalKeltnerChannelMultiplier`, `narrowKeltnerChannelMultiplier` | record{highCompression, lowCompression, momentum, normalCompression} |
| `stochastic`           | bars   | `kPeriod`, `dPeriod`, `smoothK`                                                                                                                                                  | record{d, k}                                                         |
| `stochFast`            | bars   | `kPeriod`, `dPeriod`, `smoothK`                                                                                                                                                  | record{d, k}                                                         |
| `stochRsi`             | series | `rsiPeriod`, `stochPeriod`, `kPeriod`, `dPeriod`                                                                                                                                 | record{d, k}                                                         |
| `tdSequential`         | bars   | `lookback`                                                                                                                                                                       | record{countdown, direction, setup}                                  |
| `trix`                 | series | `period`                                                                                                                                                                         | number                                                               |
| `trixHistogram`        | series | `period`, `signal`                                                                                                                                                               | record{histogram, signal, trix}                                      |
| `tsi`                  | series | `long`, `short`, `signal`                                                                                                                                                        | record{signal, tsi}                                                  |
| `ultimateOscillator`   | bars   | `short`, `medium`, `long`                                                                                                                                                        | number                                                               |
| `volumeWeightedMacd`   | bars   | `fast`, `slow`, `signal`                                                                                                                                                         | record{histogram, macd, signal}                                      |
| `williamsR`            | bars   | `period`                                                                                                                                                                         | number                                                               |

## trend (38)

| Indicator                  | Inputs | Parameters                                                                                                                     | Output                                                        |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `adx`                      | bars   | `period`                                                                                                                       | record{adx, minusDI, plusDI}                                  |
| `adxr`                     | bars   | `period`                                                                                                                       | number                                                        |
| `amat`                     | series | `fast`, `slow`, `lookback`, `movingAverageType`                                                                                | record{long, short}                                           |
| `aroon`                    | bars   | `period`                                                                                                                       | record{down, up}                                              |
| `aroonOscillator`          | bars   | `period`                                                                                                                       | number                                                        |
| `centralPivotRange`        | bars   | —                                                                                                                              | record{bottomCentral, pivot, topCentral}                      |
| `chandeKrollStop`          | bars   | `atrPeriod`, `multiplier`, `period`                                                                                            | record{long, short}                                           |
| `chandelierExit`           | bars   | `period`, `multiplier`                                                                                                         | record{long, short}                                           |
| `choppinessIndex`          | bars   | `period`                                                                                                                       | number                                                        |
| `crossSignals`             | series | `above`, `below`                                                                                                               | record{entry, exit, trend}                                    |
| `decreasing`               | series | `period`, `strict`                                                                                                             | number                                                        |
| `dmi`                      | bars   | `period`                                                                                                                       | record{dx, minusDI, minusDM, plusDI, plusDM}                  |
| `donchianTrend`            | bars   | `period`                                                                                                                       | number                                                        |
| `dx`                       | bars   | `period`                                                                                                                       | number                                                        |
| `exponentialDecay`         | series | `period`                                                                                                                       | number                                                        |
| `ichimoku`                 | bars   | `conversion`, `base`, `spanB`, `displacement`                                                                                  | record{chikou, displacement, kijun, senkouA, senkouB, tenkan} |
| `increasing`               | series | `period`, `strict`                                                                                                             | number                                                        |
| `linearDecay`              | series | `period`                                                                                                                       | number                                                        |
| `linreg`                   | series | `period`                                                                                                                       | record{angle, forecast, intercept, slope, value}              |
| `linregAngle`              | series | `period`                                                                                                                       | number                                                        |
| `linregIntercept`          | series | `period`                                                                                                                       | number                                                        |
| `linregSlope`              | series | `period`                                                                                                                       | number                                                        |
| `longRun`                  | pair   | `period`                                                                                                                       | number                                                        |
| `minusDI`                  | bars   | `period`                                                                                                                       | number                                                        |
| `minusDM`                  | bars   | `period`                                                                                                                       | number                                                        |
| `plusDI`                   | bars   | `period`                                                                                                                       | number                                                        |
| `plusDM`                   | bars   | `period`                                                                                                                       | number                                                        |
| `pMax`                     | bars   | `period`, `multiplier`                                                                                                         | record{pmax, trend}                                           |
| `psar`                     | bars   | `step`, `max`                                                                                                                  | record{sar, trend}                                            |
| `psarExt`                  | bars   | `startValue`, `offsetOnReverse`, `accelInitLong`, `accelLong`, `accelMaxLong`, `accelInitShort`, `accelShort`, `accelMaxShort` | number                                                        |
| `qstick`                   | bars   | `period`                                                                                                                       | number                                                        |
| `shortRun`                 | pair   | `period`                                                                                                                       | number                                                        |
| `supertrend`               | bars   | `period`, `multiplier`                                                                                                         | record{direction, supertrend}                                 |
| `trendSignals`             | series | —                                                                                                                              | record{entry, exit, trend}                                    |
| `tsf`                      | series | `period`                                                                                                                       | number                                                        |
| `ttmTrend`                 | bars   | `period`                                                                                                                       | number                                                        |
| `verticalHorizontalFilter` | series | `period`                                                                                                                       | number                                                        |
| `vortex`                   | bars   | `period`                                                                                                                       | record{viMinus, viPlus}                                       |

## volatility (27)

| Indicator                 | Inputs | Parameters                                                                                 | Output                                            |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `aberration`              | bars   | `period`, `atrPeriod`                                                                      | record{atr, lowerBand, upperBand, zeroLine}       |
| `accelerationBands`       | bars   | `period`, `multiplier`                                                                     | record{lower, middle, upper}                      |
| `atr`                     | bars   | `period`                                                                                   | number                                            |
| `atrBands`                | bars   | `period`, `multiplier`                                                                     | record{lower, middle, upper}                      |
| `bbands`                  | series | `period`, `standardDeviation`                                                              | record{bandwidth, lower, middle, percentB, upper} |
| `bollingerBandWidth`      | series | `period`, `standardDeviation`                                                              | number                                            |
| `bollingerPercentB`       | series | `period`, `standardDeviation`                                                              | number                                            |
| `chaikinVolatility`       | bars   | `period`, `rocPeriod`                                                                      | number                                            |
| `donchian`                | bars   | `period`                                                                                   | record{lower, middle, upper}                      |
| `elderThermometer`        | bars   | `period`, `long`, `short`                                                                  | record{long, movingAverage, short, thermo}        |
| `garmanKlass`             | bars   | `period`, `annualization`                                                                  | number                                            |
| `historicalVolatility`    | series | `period`, `annualization`                                                                  | number                                            |
| `holtWinterChannel`       | series | `levelSmoothing`, `trendSmoothing`, `accelerationSmoothing`, `varianceSmoothing`, `scalar` | record{lower, middle, upper}                      |
| `keltner`                 | bars   | `period`, `atrPeriod`, `multiplier`                                                        | record{lower, middle, upper}                      |
| `massIndex`               | bars   | `fast`, `slow`                                                                             | number                                            |
| `natr`                    | bars   | `period`                                                                                   | number                                            |
| `parkinson`               | bars   | `period`, `annualization`                                                                  | number                                            |
| `percentAtr`              | bars   | `period`                                                                                   | number                                            |
| `priceDistance`           | bars   | `drift`                                                                                    | number                                            |
| `realizedVolatility`      | series | `period`, `annualization`                                                                  | number                                            |
| `relativeVolatilityIndex` | series | `period`, `stdevPeriod`                                                                    | number                                            |
| `rogersSatchell`          | bars   | `period`, `annualization`                                                                  | number                                            |
| `standardDeviation`       | series | `period`, `sample`                                                                         | number                                            |
| `ulcerIndex`              | series | `period`                                                                                   | number                                            |
| `variance`                | series | `period`, `sample`                                                                         | number                                            |
| `volatilityStop`          | bars   | `period`, `multiplier`                                                                     | record{stop, trend}                               |
| `yangZhang`               | bars   | `period`, `annualization`                                                                  | number                                            |

The volatility estimators (`garmanKlass`, `historicalVolatility`, `parkinson`, `realizedVolatility`, `rogersSatchell`, `yangZhang`) require `annualization` — the bars per year that scales the
per-bar σ: `252` for daily bars, `52` weekly, `12` monthly, or `1` to read the per-bar σ. There is no
default, because a per-bar σ handed to `@insiderfinance/totalfinance/volatility`'s realized-vs-implied tools is silently
wrong by √252.

## volume (24)

| Indicator                 | Inputs | Parameters                                        | Output                               |
| ------------------------- | ------ | ------------------------------------------------- | ------------------------------------ |
| `adLine`                  | bars   | —                                                 | number                               |
| `archerObv`               | bars   | `fast`, `slow`, `runLength`                       | record{fast, long, obv, short, slow} |
| `chaikinMoneyFlow`        | bars   | `period`                                          | number                               |
| `chaikinOscillator`       | bars   | `fast`, `slow`                                    | number                               |
| `cvd`                     | bars   | —                                                 | number                               |
| `easeOfMovement`          | bars   | `period`, `scale`                                 | number                               |
| `efi`                     | bars   | `period`                                          | number                               |
| `emv`                     | bars   | `period`, `scale`                                 | number                               |
| `forceIndex`              | bars   | `period`                                          | number                               |
| `klinger`                 | bars   | `fast`, `slow`, `signal`                          | record{klinger, signal}              |
| `kvo`                     | bars   | `fast`, `slow`, `signal`                          | record{klinger, signal}              |
| `marketFacilitationIndex` | bars   | —                                                 | number                               |
| `mfi`                     | bars   | `period`                                          | number                               |
| `nvi`                     | bars   | —                                                 | number                               |
| `obv`                     | bars   | `talib`                                           | number                               |
| `priceVolume`             | bars   | `signed`                                          | number                               |
| `priceVolumeRank`         | bars   | —                                                 | number                               |
| `pvi`                     | bars   | —                                                 | number                               |
| `pvt`                     | bars   | —                                                 | number                               |
| `relativeVolume`          | bars   | `period`                                          | number                               |
| `vfi`                     | bars   | `period`, `coefficient`, `volumeCutoff`, `smooth` | number                               |
| `volumeOscillator`        | bars   | `fast`, `slow`                                    | number                               |
| `vwap`                    | bars   | —                                                 | number                               |
| `williamsAd`              | bars   | —                                                 | number                               |

## cycle (9)

| Indicator     | Inputs | Parameters       | Output                      |
| ------------- | ------ | ---------------- | --------------------------- |
| `dsp`         | series | `period`         | number                      |
| `ebsw`        | series | `period`, `bars` | number                      |
| `htDcPeriod`  | series | —                | number                      |
| `htDcPhase`   | series | —                | number                      |
| `htPhasor`    | series | —                | record{inPhase, quadrature} |
| `htSine`      | series | —                | record{leadSine, sine}      |
| `htTrendline` | series | —                | number                      |
| `htTrendMode` | series | —                | number                      |
| `msw`         | series | `period`         | record{lead, sine}          |

## math (21)

| Indicator   | Inputs | Parameters | Output |
| ----------- | ------ | ---------- | ------ |
| `acos`      | series | —          | number |
| `add`       | pair   | —          | number |
| `asin`      | series | —          | number |
| `atan`      | series | —          | number |
| `ceil`      | series | —          | number |
| `cos`       | series | —          | number |
| `cosh`      | series | —          | number |
| `crossany`  | pair   | —          | number |
| `crossover` | pair   | —          | number |
| `div`       | pair   | —          | number |
| `exp`       | series | —          | number |
| `floor`     | series | —          | number |
| `ln`        | series | —          | number |
| `log10`     | series | —          | number |
| `mult`      | pair   | —          | number |
| `sin`       | series | —          | number |
| `sinh`      | series | —          | number |
| `sqrt`      | series | —          | number |
| `sub`       | pair   | —          | number |
| `tan`       | series | —          | number |
| `tanh`      | series | —          | number |

## performance (1)

| Indicator  | Inputs | Parameters | Output                         |
| ---------- | ------ | ---------- | ------------------------------ |
| `drawdown` | series | —          | record{drawdown, log, percent} |

## statistic (39)

| Indicator            | Inputs | Parameters                 | Output                             |
| -------------------- | ------ | -------------------------- | ---------------------------------- |
| `barSince`           | series | —                          | number                             |
| `beta`               | pair   | `period`                   | number                             |
| `change`             | series | `period`                   | number                             |
| `correl`             | pair   | `period`                   | number                             |
| `covariance`         | pair   | `period`, `sample`         | number                             |
| `cum`                | series | —                          | number                             |
| `diff`               | series | `period`                   | number                             |
| `entropy`            | series | `period`                   | number                             |
| `fractionalChange`   | series | `period`                   | number                             |
| `highestBars`        | series | `period`                   | number                             |
| `kurtosis`           | series | `period`                   | number                             |
| `lag`                | series | `period`                   | number                             |
| `lowestBars`         | series | `period`                   | number                             |
| `mad`                | series | `period`                   | number                             |
| `normalize`          | series | `period`                   | number                             |
| `percentRank`        | series | `period`                   | number                             |
| `rescale`            | series | `period`, `min`, `max`     | number                             |
| `rollingBeta`        | pair   | `period`                   | number                             |
| `rollingCorrelation` | pair   | `period`                   | number                             |
| `rollingMax`         | series | `period`                   | number                             |
| `rollingMaxIndex`    | series | `period`                   | number                             |
| `rollingMean`        | series | `period`                   | number                             |
| `rollingMedian`      | series | `period`                   | number                             |
| `rollingMin`         | series | `period`                   | number                             |
| `rollingMinIndex`    | series | `period`                   | number                             |
| `rollingMinMax`      | series | `period`                   | record{max, min}                   |
| `rollingMinMaxIndex` | series | `period`                   | record{maxIndex, minIndex}         |
| `rollingQuantile`    | series | `period`, `quantile`       | number                             |
| `rollingRank`        | series | `period`                   | number                             |
| `rollingRegression`  | pair   | `period`                   | record{intercept, rSquared, slope} |
| `rollingSum`         | series | `period`                   | number                             |
| `rSquared`           | pair   | `period`                   | number                             |
| `shift`              | series | `period`                   | number                             |
| `skew`               | series | `period`                   | number                             |
| `standardError`      | series | `period`                   | number                             |
| `tosStdevAll`        | series | `period`, `stds`, `ddof`   | record{line, lower, upper}         |
| `valueWhen`          | pair   | `occurrence`               | number                             |
| `winsorize`          | series | `period`, `lower`, `upper` | number                             |
| `zScore`             | series | `period`                   | number                             |

## candlestick (65)

| Indicator              | Inputs | Parameters       | Output                         |
| ---------------------- | ------ | ---------------- | ------------------------------ |
| `abandonedBaby`        | bars   | —                | number                         |
| `advanceBlock`         | bars   | —                | number                         |
| `beltHold`             | bars   | —                | number                         |
| `breakaway`            | bars   | —                | number                         |
| `cdlDoji`              | bars   | —                | number                         |
| `cdlInside`            | bars   | —                | number                         |
| `cdlZ`                 | bars   | `period`, `ddof` | record{close, high, low, open} |
| `closingMarubozu`      | bars   | —                | number                         |
| `concealBabySwallow`   | bars   | —                | number                         |
| `counterattack`        | bars   | —                | number                         |
| `darkCloudCover`       | bars   | —                | number                         |
| `doji`                 | bars   | —                | number                         |
| `dojiStar`             | bars   | —                | number                         |
| `dragonflyDoji`        | bars   | —                | number                         |
| `engulfing`            | bars   | —                | number                         |
| `eveningDojiStar`      | bars   | —                | number                         |
| `eveningStar`          | bars   | —                | number                         |
| `gapSideSideWhite`     | bars   | —                | number                         |
| `gravestoneDoji`       | bars   | —                | number                         |
| `hammer`               | bars   | —                | number                         |
| `hangingMan`           | bars   | —                | number                         |
| `harami`               | bars   | —                | number                         |
| `haramiCross`          | bars   | —                | number                         |
| `highWave`             | bars   | —                | number                         |
| `hikkake`              | bars   | —                | number                         |
| `hikkakeMod`           | bars   | —                | number                         |
| `homingPigeon`         | bars   | —                | number                         |
| `identicalThreeCrows`  | bars   | —                | number                         |
| `inNeck`               | bars   | —                | number                         |
| `inside`               | bars   | —                | number                         |
| `invertedHammer`       | bars   | —                | number                         |
| `kicking`              | bars   | —                | number                         |
| `kickingByLength`      | bars   | —                | number                         |
| `ladderBottom`         | bars   | —                | number                         |
| `longLeggedDoji`       | bars   | —                | number                         |
| `longLine`             | bars   | —                | number                         |
| `marubozu`             | bars   | —                | number                         |
| `matchingLow`          | bars   | —                | number                         |
| `matHold`              | bars   | —                | number                         |
| `morningDojiStar`      | bars   | —                | number                         |
| `morningStar`          | bars   | —                | number                         |
| `onNeck`               | bars   | —                | number                         |
| `piercing`             | bars   | —                | number                         |
| `rickshawMan`          | bars   | —                | number                         |
| `riseFallThreeMethods` | bars   | —                | number                         |
| `separatingLines`      | bars   | —                | number                         |
| `shootingStar`         | bars   | —                | number                         |
| `shortLine`            | bars   | —                | number                         |
| `spinningTop`          | bars   | —                | number                         |
| `stalledPattern`       | bars   | —                | number                         |
| `stickSandwich`        | bars   | —                | number                         |
| `takuri`               | bars   | —                | number                         |
| `tasukiGap`            | bars   | —                | number                         |
| `threeBlackCrows`      | bars   | —                | number                         |
| `threeInside`          | bars   | —                | number                         |
| `threeLineStrike`      | bars   | —                | number                         |
| `threeOutside`         | bars   | —                | number                         |
| `threeStarsInSouth`    | bars   | —                | number                         |
| `threeWhiteSoldiers`   | bars   | —                | number                         |
| `thrusting`            | bars   | —                | number                         |
| `triStar`              | bars   | —                | number                         |
| `twoCrows`             | bars   | —                | number                         |
| `uniqueThreeRiver`     | bars   | —                | number                         |
| `upsideGapTwoCrows`    | bars   | —                | number                         |
| `xSideGapThreeMethods` | bars   | —                | number                         |

## price-action (8)

| Indicator           | Inputs | Parameters              | Output                                            |
| ------------------- | ------ | ----------------------- | ------------------------------------------------- |
| `atrTrailingStop`   | bars   | `period`, `multiplier`  | record{stop, trend}                               |
| `divergence`        | pair   | `swing`, `kinds`        | record{code, index, indicatorSwings, priceSwings} |
| `equalHighs`        | bars   | `strength`, `tolerance` | record{count, detected, level}                    |
| `equalLows`         | bars   | `strength`, `tolerance` | record{count, detected, level}                    |
| `fairValueGaps`     | bars   | `minimumGapPercent`     | record{bottom, direction, mid, top}               |
| `liquiditySweeps`   | bars   | `lookback`              | record{direction, level}                          |
| `orderBlocks`       | bars   | `lookback`              | record{bottom, direction, mid, top}               |
| `swingTrailingStop` | bars   | `strength`              | record{stop, trend}                               |
