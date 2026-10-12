/** Three explicit prices for approximate ES → SPY proportional mapping. */
export interface EsToSpyLevelInput {
  /** Requested level in ES index points; finite and nonnegative. */
  esPriceLevel: number;
  /** Comparable reference in ES index points; finite and positive. */
  referenceEsPrice: number;
  /** Comparable reference in USD per SPY share; finite and positive. */
  referenceSpyPrice: number;
}

/** Three explicit prices for approximate SPY → ES proportional mapping. */
export interface SpyToEsLevelInput {
  /** Requested level in USD per SPY share; finite and nonnegative. */
  spyPriceLevel: number;
  /** Comparable reference in USD per SPY share; finite and positive. */
  referenceSpyPrice: number;
  /** Comparable reference in ES index points; finite and positive. */
  referenceEsPrice: number;
}

/** Three explicit prices for approximate NQ → QQQ proportional mapping. */
export interface NqToQqqLevelInput {
  /** Requested level in NQ index points; finite and nonnegative. */
  nqPriceLevel: number;
  /** Comparable reference in NQ index points; finite and positive. */
  referenceNqPrice: number;
  /** Comparable reference in USD per QQQ share; finite and positive. */
  referenceQqqPrice: number;
}

/** Three explicit prices for approximate QQQ → NQ proportional mapping. */
export interface QqqToNqLevelInput {
  /** Requested level in USD per QQQ share; finite and nonnegative. */
  qqqPriceLevel: number;
  /** Comparable reference in USD per QQQ share; finite and positive. */
  referenceQqqPrice: number;
  /** Comparable reference in NQ index points; finite and positive. */
  referenceNqPrice: number;
}

/** Three explicit prices for approximate YM → DIA proportional mapping. */
export interface YmToDiaLevelInput {
  /** Requested level in YM index points; finite and nonnegative. */
  ymPriceLevel: number;
  /** Comparable reference in YM index points; finite and positive. */
  referenceYmPrice: number;
  /** Comparable reference in USD per DIA share; finite and positive. */
  referenceDiaPrice: number;
}

/** Three explicit prices for approximate DIA → YM proportional mapping. */
export interface DiaToYmLevelInput {
  /** Requested level in USD per DIA share; finite and nonnegative. */
  diaPriceLevel: number;
  /** Comparable reference in USD per DIA share; finite and positive. */
  referenceDiaPrice: number;
  /** Comparable reference in YM index points; finite and positive. */
  referenceYmPrice: number;
}

/** Three explicit prices for approximate RTY → IWM proportional mapping. */
export interface RtyToIwmLevelInput {
  /** Requested level in RTY index points; finite and nonnegative. */
  rtyPriceLevel: number;
  /** Comparable reference in RTY index points; finite and positive. */
  referenceRtyPrice: number;
  /** Comparable reference in USD per IWM share; finite and positive. */
  referenceIwmPrice: number;
}

/** Three explicit prices for approximate IWM → RTY proportional mapping. */
export interface IwmToRtyLevelInput {
  /** Requested level in USD per IWM share; finite and nonnegative. */
  iwmPriceLevel: number;
  /** Comparable reference in USD per IWM share; finite and positive. */
  referenceIwmPrice: number;
  /** Comparable reference in RTY index points; finite and positive. */
  referenceRtyPrice: number;
}

/** Three explicit prices for approximate SPX → SPY proportional mapping. */
export interface SpxToSpyLevelInput {
  /** Requested level in SPX index points; finite and nonnegative. */
  spxPriceLevel: number;
  /** Comparable reference in SPX index points; finite and positive. */
  referenceSpxPrice: number;
  /** Comparable reference in USD per SPY share; finite and positive. */
  referenceSpyPrice: number;
}

/** Three explicit prices for approximate SPY → SPX proportional mapping. */
export interface SpyToSpxLevelInput {
  /** Requested level in USD per SPY share; finite and nonnegative. */
  spyPriceLevel: number;
  /** Comparable reference in USD per SPY share; finite and positive. */
  referenceSpyPrice: number;
  /** Comparable reference in SPX index points; finite and positive. */
  referenceSpxPrice: number;
}

/** Three explicit prices for approximate NDX → QQQ proportional mapping. */
export interface NdxToQqqLevelInput {
  /** Requested level in NDX index points; finite and nonnegative. */
  ndxPriceLevel: number;
  /** Comparable reference in NDX index points; finite and positive. */
  referenceNdxPrice: number;
  /** Comparable reference in USD per QQQ share; finite and positive. */
  referenceQqqPrice: number;
}

/** Three explicit prices for approximate QQQ → NDX proportional mapping. */
export interface QqqToNdxLevelInput {
  /** Requested level in USD per QQQ share; finite and nonnegative. */
  qqqPriceLevel: number;
  /** Comparable reference in USD per QQQ share; finite and positive. */
  referenceQqqPrice: number;
  /** Comparable reference in NDX index points; finite and positive. */
  referenceNdxPrice: number;
}

/** Three explicit prices for approximate RUT → IWM proportional mapping. */
export interface RutToIwmLevelInput {
  /** Requested level in RUT index points; finite and nonnegative. */
  rutPriceLevel: number;
  /** Comparable reference in RUT index points; finite and positive. */
  referenceRutPrice: number;
  /** Comparable reference in USD per IWM share; finite and positive. */
  referenceIwmPrice: number;
}

/** Three explicit prices for approximate IWM → RUT proportional mapping. */
export interface IwmToRutLevelInput {
  /** Requested level in USD per IWM share; finite and nonnegative. */
  iwmPriceLevel: number;
  /** Comparable reference in USD per IWM share; finite and positive. */
  referenceIwmPrice: number;
  /** Comparable reference in RUT index points; finite and positive. */
  referenceRutPrice: number;
}

/** Three explicit prices for approximate DJIA → DIA proportional mapping. */
export interface DjiaToDiaLevelInput {
  /** Requested level in DJIA index points (full Dow Jones Industrial Average); finite and nonnegative. */
  djiaPriceLevel: number;
  /** Comparable reference in DJIA index points (full Dow Jones Industrial Average); finite and positive. */
  referenceDjiaPrice: number;
  /** Comparable reference in USD per DIA share; finite and positive. */
  referenceDiaPrice: number;
}

/** Three explicit prices for approximate DIA → DJIA proportional mapping. */
export interface DiaToDjiaLevelInput {
  /** Requested level in USD per DIA share; finite and nonnegative. */
  diaPriceLevel: number;
  /** Comparable reference in USD per DIA share; finite and positive. */
  referenceDiaPrice: number;
  /** Comparable reference in DJIA index points (full Dow Jones Industrial Average); finite and positive. */
  referenceDjiaPrice: number;
}
