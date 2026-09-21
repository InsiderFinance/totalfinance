# TotalFinance indicator compatibility matrix

Cross-reference of TotalFinance canonical names against TA-Lib, pandas-ta and TradingView. Any name below resolves via `resolveIndicator` (case-insensitive). 225 of 335 registered indicators are mapped.

## transform (8)

| TotalFinance    | TA-Lib     | pandas-ta           | TradingView    |
| --------------- | ---------- | ------------------- | -------------- |
| `averagePrice`  | `AVGPRICE` | `avgprice`, `ohlc4` | Average Price  |
| `heikinAshi`    | —          | `ha`                | Heikin Ashi    |
| `logReturns`    | —          | `log_return`        | —              |
| `medianPrice`   | `MEDPRICE` | `hl2`, `medprice`   | Median Price   |
| `returns`       | —          | `percent_return`    | —              |
| `trueRange`     | `TRANGE`   | `true_range`        | —              |
| `typicalPrice`  | `TYPPRICE` | `hlc3`, `typprice`  | Typical Price  |
| `weightedClose` | `WCLPRICE` | `wcp`               | Weighted Close |

## moving-average (29)

| TotalFinance              | TA-Lib     | pandas-ta  | TradingView         |
| ------------------------- | ---------- | ---------- | ------------------- |
| `alma`                    | —          | `alma`     | ALMA                |
| `dema`                    | `DEMA`     | `dema`     | —                   |
| `ema`                     | `EMA`      | `ema`      | EMA                 |
| `fwma`                    | —          | `fwma`     | —                   |
| `gannHighLowActivator`    | —          | `hilo`     | Gann HiLo Activator |
| `hma`                     | —          | `hma`      | HMA                 |
| `holtWinterMovingAverage` | —          | `hwma`     | —                   |
| `jma`                     | —          | `jma`      | —                   |
| `kama`                    | `KAMA`     | `kama`     | —                   |
| `mama`                    | `MAMA`     | `mama`     | —                   |
| `mcginley`                | —          | `mcgd`     | McGinley Dynamic    |
| `midpoint`                | `MIDPOINT` | `midpoint` | —                   |
| `midprice`                | `MIDPRICE` | `midprice` | —                   |
| `movingAverage`           | `MA`       | `ma`       | —                   |
| `movingAverageRibbon`     | —          | `mmar`     | —                   |
| `pascalWma`               | —          | `pwma`     | —                   |
| `rainbowMovingAverage`    | —          | `rainbow`  | —                   |
| `rma`                     | —          | `rma`      | RMA                 |
| `sineWma`                 | —          | `sinwma`   | —                   |
| `sma`                     | `SMA`      | `sma`      | SMA                 |
| `superSmoother`           | —          | `ssf`      | —                   |
| `symmetricWma`            | —          | `swma`     | —                   |
| `t3`                      | `T3`       | `t3`       | —                   |
| `tema`                    | `TEMA`     | `tema`     | —                   |
| `trima`                   | `TRIMA`    | `trima`    | —                   |
| `vidya`                   | —          | `vidya`    | VIDYA               |
| `vwma`                    | —          | `vwma`     | VWMA                |
| `wma`                     | `WMA`      | `wma`      | WMA                 |
| `zlema`                   | —          | `zlma`     | ZLEMA               |

## momentum (53)

| TotalFinance           | TA-Lib     | pandas-ta     | TradingView        |
| ---------------------- | ---------- | ------------- | ------------------ |
| `apo`                  | `APO`      | `apo`         | —                  |
| `awesomeOscillator`    | —          | `ao`          | Awesome Oscillator |
| `bias`                 | —          | `bias`        | —                  |
| `bop`                  | `BOP`      | `bop`         | —                  |
| `brar`                 | —          | `brar`        | —                  |
| `cci`                  | `CCI`      | `cci`         | CCI                |
| `centerOfGravity`      | —          | `cg`          | —                  |
| `cfo`                  | —          | `cfo`         | —                  |
| `cmo`                  | `CMO`      | `cmo`         | —                  |
| `coppock`              | —          | `coppock`     | Coppock Curve      |
| `cti`                  | —          | `cti`         | —                  |
| `dpo`                  | —          | `dpo`         | —                  |
| `efficiencyRatio`      | —          | `er`          | —                  |
| `elderRay`             | —          | `eri`         | Elder Ray          |
| `fisherTransform`      | —          | `fisher`      | Fisher Transform   |
| `forecastOscillator`   | —          | `fosc`        | —                  |
| `inertia`              | —          | `inertia`     | —                  |
| `kdj`                  | —          | `kdj`         | KDJ                |
| `kst`                  | —          | `kst`         | KST                |
| `laguerreRsi`          | —          | `lrsi`        | —                  |
| `macd`                 | `MACD`     | `macd`        | MACD               |
| `macdExt`              | `MACDEXT`  | `macdext`     | —                  |
| `macdFix`              | `MACDFIX`  | `macdfix`     | —                  |
| `momentum`             | `MOM`      | `mom`         | —                  |
| `pgo`                  | —          | `pgo`         | —                  |
| `ppo`                  | `PPO`      | `ppo`         | —                  |
| `projectionOscillator` | —          | `po`          | —                  |
| `psychologicalLine`    | —          | `psl`         | —                  |
| `pvo`                  | —          | `pvo`         | —                  |
| `qqe`                  | —          | `qqe`         | QQE                |
| `relativeVigorIndex`   | —          | `rvgi`        | RVGI               |
| `roc`                  | `ROC`      | `roc`         | —                  |
| `rocp`                 | `ROCP`     | `rocp`        | —                  |
| `rocr`                 | `ROCR`     | `rocr`        | —                  |
| `rocr100`              | `ROCR100`  | `rocr100`     | —                  |
| `rsi`                  | `RSI`      | `rsi`         | RSI                |
| `rsx`                  | —          | `rsx`         | —                  |
| `schaffTrendCycle`     | —          | `stc`         | Schaff Trend Cycle |
| `slope`                | —          | `slope`       | —                  |
| `smcSweep`             | —          | `smc_sweep`   | —                  |
| `smiErgodic`           | —          | `smi`         | SMI Ergodic        |
| `squeeze`              | —          | `squeeze`     | TTM Squeeze        |
| `squeezePro`           | —          | `squeeze_pro` | —                  |
| `stochastic`           | `STOCH`    | `stoch`       | Stochastic         |
| `stochFast`            | `STOCHF`   | `stochf`      | —                  |
| `stochRsi`             | `STOCHRSI` | `stochrsi`    | Stochastic RSI     |
| `tdSequential`         | —          | `td_seq`      | TD Sequential      |
| `trix`                 | `TRIX`     | `trix`        | —                  |
| `trixHistogram`        | —          | `trixh`       | —                  |
| `tsi`                  | —          | `tsi`         | TSI                |
| `ultimateOscillator`   | `ULTOSC`   | `uo`          | —                  |
| `volumeWeightedMacd`   | —          | `vwmacd`      | —                  |
| `williamsR`            | `WILLR`    | `willr`       | Williams %R        |

## trend (37)

| TotalFinance               | TA-Lib                | pandas-ta               | TradingView         |
| -------------------------- | --------------------- | ----------------------- | ------------------- |
| `adx`                      | `ADX`                 | `adx`                   | ADX                 |
| `adxr`                     | `ADXR`                | `adxr`                  | —                   |
| `amat`                     | —                     | `amat`                  | —                   |
| `aroon`                    | `AROON`               | `aroon`                 | Aroon               |
| `aroonOscillator`          | `AROONOSC`            | `aroonosc`              | —                   |
| `centralPivotRange`        | —                     | `cpr`, `cpr_option`     | Central Pivot Range |
| `chandeKrollStop`          | —                     | `cksp`                  | Chande Kroll Stop   |
| `chandelierExit`           | —                     | `ce`                    | Chandelier Exit     |
| `choppinessIndex`          | —                     | `chop`                  | Choppiness Index    |
| `crossSignals`             | —                     | `xsignals`              | —                   |
| `decreasing`               | —                     | `decreasing`            | —                   |
| `dmi`                      | —                     | `dm`                    | —                   |
| `dx`                       | `DX`                  | `dx`                    | —                   |
| `exponentialDecay`         | —                     | `edecay`                | —                   |
| `ichimoku`                 | —                     | `ichimoku`              | Ichimoku Cloud      |
| `increasing`               | —                     | `increasing`            | —                   |
| `linearDecay`              | —                     | `decay`, `linear_decay` | —                   |
| `linreg`                   | `LINEARREG`           | `linreg`                | —                   |
| `linregAngle`              | `LINEARREG_ANGLE`     | `linregangle`           | —                   |
| `linregIntercept`          | `LINEARREG_INTERCEPT` | `linregintercept`       | —                   |
| `linregSlope`              | `LINEARREG_SLOPE`     | `linregslope`           | —                   |
| `longRun`                  | —                     | `long_run`              | —                   |
| `minusDI`                  | `MINUS_DI`            | —                       | —                   |
| `minusDM`                  | `MINUS_DM`            | `minus_dm`              | —                   |
| `plusDI`                   | `PLUS_DI`             | —                       | —                   |
| `plusDM`                   | `PLUS_DM`             | `plus_dm`               | —                   |
| `pMax`                     | —                     | `pmax`                  | PMax                |
| `psar`                     | `SAR`                 | `psar`                  | Parabolic SAR       |
| `psarExt`                  | `SAREXT`              | `sarext`                | —                   |
| `qstick`                   | —                     | `qstick`                | —                   |
| `shortRun`                 | —                     | `short_run`             | —                   |
| `supertrend`               | —                     | `supertrend`            | Supertrend          |
| `trendSignals`             | —                     | `tsignals`              | —                   |
| `tsf`                      | `TSF`                 | `tsf`                   | —                   |
| `ttmTrend`                 | —                     | `ttm_trend`             | TTM Trend           |
| `verticalHorizontalFilter` | —                     | `vhf`                   | —                   |
| `vortex`                   | —                     | `vortex`                | Vortex              |

## volatility (17)

| TotalFinance              | TA-Lib   | pandas-ta         | TradingView               |
| ------------------------- | -------- | ----------------- | ------------------------- |
| `aberration`              | —        | `aberration`      | —                         |
| `accelerationBands`       | —        | `accbands`        | Acceleration Bands        |
| `atr`                     | `ATR`    | `atr`             | ATR                       |
| `bbands`                  | `BBANDS` | `bbands`          | Bollinger Bands           |
| `chaikinVolatility`       | —        | `cvi`             | —                         |
| `donchian`                | —        | `donchian`        | Donchian Channels         |
| `elderThermometer`        | —        | `thermo`          | —                         |
| `historicalVolatility`    | —        | `hvol`, `avolume` | —                         |
| `holtWinterChannel`       | —        | `hwc`             | —                         |
| `keltner`                 | —        | `kc`              | Keltner Channels          |
| `massIndex`               | —        | `massi`           | Mass Index                |
| `natr`                    | `NATR`   | `natr`            | —                         |
| `priceDistance`           | —        | `pdist`           | —                         |
| `relativeVolatilityIndex` | —        | `rvi`             | Relative Volatility Index |
| `standardDeviation`       | `STDDEV` | `stdev`           | —                         |
| `ulcerIndex`              | —        | `ui`              | Ulcer Index               |
| `variance`                | `VAR`    | `variance`        | —                         |

## volume (18)

| TotalFinance              | TA-Lib  | pandas-ta  | TradingView               |
| ------------------------- | ------- | ---------- | ------------------------- |
| `adLine`                  | `AD`    | `ad`       | Accumulation/Distribution |
| `archerObv`               | —       | `aobv`     | —                         |
| `chaikinMoneyFlow`        | —       | `cmf`      | CMF                       |
| `chaikinOscillator`       | `ADOSC` | `adosc`    | —                         |
| `easeOfMovement`          | —       | `eom`      | Ease of Movement          |
| `forceIndex`              | —       | `efi`      | Force Index               |
| `klinger`                 | —       | `kvo`      | Klinger Oscillator        |
| `marketFacilitationIndex` | —       | `marketfi` | Market Facilitation Index |
| `mfi`                     | `MFI`   | `mfi`      | Money Flow Index          |
| `nvi`                     | —       | `nvi`      | —                         |
| `obv`                     | `OBV`   | `obv`      | OBV                       |
| `priceVolume`             | —       | `pvol`     | —                         |
| `priceVolumeRank`         | —       | `pvr`      | —                         |
| `pvi`                     | —       | `pvi`      | —                         |
| `pvt`                     | —       | `pvt`      | Price Volume Trend        |
| `volumeOscillator`        | —       | `vosc`     | Volume Oscillator         |
| `vwap`                    | —       | `vwap`     | VWAP                      |
| `williamsAd`              | —       | `wad`      | Williams A/D              |

## cycle (9)

| TotalFinance  | TA-Lib         | pandas-ta      | TradingView |
| ------------- | -------------- | -------------- | ----------- |
| `dsp`         | —              | `dsp`          | —           |
| `ebsw`        | —              | `ebsw`         | —           |
| `htDcPeriod`  | `HT_DCPERIOD`  | `ht_dcperiod`  | —           |
| `htDcPhase`   | `HT_DCPHASE`   | `ht_dcphase`   | —           |
| `htPhasor`    | `HT_PHASOR`    | `ht_phasor`    | —           |
| `htSine`      | `HT_SINE`      | `ht_sine`      | —           |
| `htTrendline` | `HT_TRENDLINE` | `ht_trendline` | —           |
| `htTrendMode` | `HT_TRENDMODE` | `ht_trendmode` | —           |
| `msw`         | —              | `msw`          | —           |

## math (21)

| TotalFinance | TA-Lib  | pandas-ta   | TradingView |
| ------------ | ------- | ----------- | ----------- |
| `acos`       | `ACOS`  | `acos`      | —           |
| `add`        | `ADD`   | `add`       | —           |
| `asin`       | `ASIN`  | `asin`      | —           |
| `atan`       | `ATAN`  | `atan`      | —           |
| `ceil`       | `CEIL`  | `ceil`      | —           |
| `cos`        | `COS`   | `cos`       | —           |
| `cosh`       | `COSH`  | `cosh`      | —           |
| `crossany`   | —       | `crossany`  | —           |
| `crossover`  | —       | `crossover` | —           |
| `div`        | `DIV`   | `div`       | —           |
| `exp`        | `EXP`   | `exp`       | —           |
| `floor`      | `FLOOR` | `floor`     | —           |
| `ln`         | `LN`    | `ln`        | —           |
| `log10`      | `LOG10` | `log10`     | —           |
| `mult`       | `MULT`  | `mult`      | —           |
| `sin`        | `SIN`   | `sin`       | —           |
| `sinh`       | `SINH`  | `sinh`      | —           |
| `sqrt`       | `SQRT`  | `sqrt`      | —           |
| `sub`        | `SUB`   | `sub`       | —           |
| `tan`        | `TAN`   | `tan`       | —           |
| `tanh`       | `TANH`  | `tanh`      | —           |

## performance (1)

| TotalFinance | TA-Lib | pandas-ta  | TradingView |
| ------------ | ------ | ---------- | ----------- |
| `drawdown`   | —      | `drawdown` | —           |

## statistic (22)

| TotalFinance         | TA-Lib        | pandas-ta      | TradingView |
| -------------------- | ------------- | -------------- | ----------- |
| `barSince`           | —             | —              | BarsSince   |
| `beta`               | `BETA`        | `beta`         | —           |
| `correl`             | `CORREL`      | `correl`       | —           |
| `entropy`            | —             | `entropy`      | —           |
| `highestBars`        | —             | —              | HighestBars |
| `kurtosis`           | —             | `kurtosis`     | —           |
| `lowestBars`         | —             | —              | LowestBars  |
| `mad`                | —             | `mad`, `md`    | —           |
| `rollingMax`         | `MAX`         | `rolling_max`  | —           |
| `rollingMaxIndex`    | `MAXINDEX`    | —              | —           |
| `rollingMedian`      | —             | `median`       | —           |
| `rollingMin`         | `MIN`         | `rolling_min`  | —           |
| `rollingMinIndex`    | `MININDEX`    | —              | —           |
| `rollingMinMax`      | `MINMAX`      | —              | —           |
| `rollingMinMaxIndex` | `MINMAXINDEX` | —              | —           |
| `rollingQuantile`    | —             | `quantile`     | —           |
| `rollingSum`         | `SUM`         | `rolling_sum`  | —           |
| `skew`               | —             | `skew`         | —           |
| `standardError`      | —             | —              | —           |
| `tosStdevAll`        | —             | `tos_stdevall` | —           |
| `valueWhen`          | —             | —              | ValueWhen   |
| `zScore`             | —             | `zscore`       | —           |

## candlestick (3)

| TotalFinance | TA-Lib | pandas-ta    | TradingView |
| ------------ | ------ | ------------ | ----------- |
| `cdlDoji`    | —      | `cdl_doji`   | —           |
| `cdlInside`  | —      | `cdl_inside` | —           |
| `cdlZ`       | —      | `cdl_z`      | —           |

## price-action (7)

| TotalFinance        | TA-Lib | pandas-ta | TradingView         |
| ------------------- | ------ | --------- | ------------------- |
| `atrTrailingStop`   | —      | —         | ATR Trailing Stop   |
| `equalHighs`        | —      | —         | Equal Highs         |
| `equalLows`         | —      | —         | Equal Lows          |
| `fairValueGaps`     | —      | —         | Fair Value Gap      |
| `liquiditySweeps`   | —      | —         | Liquidity Sweep     |
| `orderBlocks`       | —      | —         | Order Block         |
| `swingTrailingStop` | —      | —         | Swing Trailing Stop |
