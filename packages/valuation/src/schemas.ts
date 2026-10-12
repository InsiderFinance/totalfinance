/** Runtime schemas are a separate import so compute calls remain free of schema machinery. */
import { schema, type Schema } from '@totalfinance/core/schema';
import { type ConvertPriceLevelInput } from './price-level-input.js';
import type {
  EsToSpyLevelInput,
  SpyToEsLevelInput,
  NqToQqqLevelInput,
  QqqToNqLevelInput,
  YmToDiaLevelInput,
  DiaToYmLevelInput,
  RtyToIwmLevelInput,
  IwmToRtyLevelInput,
  SpxToSpyLevelInput,
  SpyToSpxLevelInput,
  NdxToQqqLevelInput,
  QqqToNdxLevelInput,
  RutToIwmLevelInput,
  IwmToRutLevelInput,
  DjiaToDiaLevelInput,
  DiaToDjiaLevelInput,
} from './price-level-named-inputs.js';

const coordinates = {
  sourcePriceLevel: schema
    .number()
    .nonnegative()
    .describe('Source price level in sourcePriceUnit; finite and nonnegative.'),
  sourcePriceUnit: schema
    .string()
    .regex(/\S/)
    .optional()
    .describe('Optional caller-supplied source price unit label; nonblank when supplied.'),
  targetPriceUnit: schema
    .string()
    .regex(/\S/)
    .optional()
    .describe('Optional result-unit label; nonblank when supplied, unspecified when omitted.'),
};

/** Closed request schema for {@link convertPriceLevel}; select exactly one explicit method. */
export const ConvertPriceLevelInputSchema: Schema<ConvertPriceLevelInput> = schema
  .union([
    schema.object({
      ...coordinates,
      method: schema.literal('reference-prices'),
      referenceSourcePrice: schema
        .number()
        .positive()
        .describe('Positive reference price in sourcePriceUnit; denominator.'),
      referenceTargetPrice: schema
        .number()
        .positive()
        .describe('Positive reference price in targetPriceUnit.'),
    }),
    schema.object({
      ...coordinates,
      method: schema.literal('ratio'),
      targetPricePerSourcePrice: schema
        .number()
        .positive()
        .describe('Positive ratio: target price units per ONE source price unit.'),
    }),
  ])
  .describe(
    'Approximate proportional price mapping with optional descriptive units and no financial defaults.',
  );

/** Closed three-price request for {@link esToSpyLevel}; never fetches or assumes reference prices. */
export const EsToSpyLevelInputSchema: Schema<EsToSpyLevelInput> = schema.object({
  esPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in ES index points; finite and nonnegative.'),
  referenceEsPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in ES index points; finite and positive.'),
  referenceSpyPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per SPY share; finite and positive.'),
});

/** Closed three-price request for {@link spyToEsLevel}; never fetches or assumes reference prices. */
export const SpyToEsLevelInputSchema: Schema<SpyToEsLevelInput> = schema.object({
  spyPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per SPY share; finite and nonnegative.'),
  referenceSpyPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per SPY share; finite and positive.'),
  referenceEsPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in ES index points; finite and positive.'),
});

/** Closed three-price request for {@link nqToQqqLevel}; never fetches or assumes reference prices. */
export const NqToQqqLevelInputSchema: Schema<NqToQqqLevelInput> = schema.object({
  nqPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in NQ index points; finite and nonnegative.'),
  referenceNqPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in NQ index points; finite and positive.'),
  referenceQqqPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per QQQ share; finite and positive.'),
});

/** Closed three-price request for {@link qqqToNqLevel}; never fetches or assumes reference prices. */
export const QqqToNqLevelInputSchema: Schema<QqqToNqLevelInput> = schema.object({
  qqqPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per QQQ share; finite and nonnegative.'),
  referenceQqqPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per QQQ share; finite and positive.'),
  referenceNqPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in NQ index points; finite and positive.'),
});

/** Closed three-price request for {@link ymToDiaLevel}; never fetches or assumes reference prices. */
export const YmToDiaLevelInputSchema: Schema<YmToDiaLevelInput> = schema.object({
  ymPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in YM index points; finite and nonnegative.'),
  referenceYmPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in YM index points; finite and positive.'),
  referenceDiaPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per DIA share; finite and positive.'),
});

/** Closed three-price request for {@link diaToYmLevel}; never fetches or assumes reference prices. */
export const DiaToYmLevelInputSchema: Schema<DiaToYmLevelInput> = schema.object({
  diaPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per DIA share; finite and nonnegative.'),
  referenceDiaPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per DIA share; finite and positive.'),
  referenceYmPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in YM index points; finite and positive.'),
});

/** Closed three-price request for {@link rtyToIwmLevel}; never fetches or assumes reference prices. */
export const RtyToIwmLevelInputSchema: Schema<RtyToIwmLevelInput> = schema.object({
  rtyPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in RTY index points; finite and nonnegative.'),
  referenceRtyPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in RTY index points; finite and positive.'),
  referenceIwmPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per IWM share; finite and positive.'),
});

/** Closed three-price request for {@link iwmToRtyLevel}; never fetches or assumes reference prices. */
export const IwmToRtyLevelInputSchema: Schema<IwmToRtyLevelInput> = schema.object({
  iwmPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per IWM share; finite and nonnegative.'),
  referenceIwmPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per IWM share; finite and positive.'),
  referenceRtyPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in RTY index points; finite and positive.'),
});

/** Closed three-price request for {@link spxToSpyLevel}; never fetches or assumes reference prices. */
export const SpxToSpyLevelInputSchema: Schema<SpxToSpyLevelInput> = schema.object({
  spxPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in SPX index points; finite and nonnegative.'),
  referenceSpxPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in SPX index points; finite and positive.'),
  referenceSpyPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per SPY share; finite and positive.'),
});

/** Closed three-price request for {@link spyToSpxLevel}; never fetches or assumes reference prices. */
export const SpyToSpxLevelInputSchema: Schema<SpyToSpxLevelInput> = schema.object({
  spyPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per SPY share; finite and nonnegative.'),
  referenceSpyPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per SPY share; finite and positive.'),
  referenceSpxPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in SPX index points; finite and positive.'),
});

/** Closed three-price request for {@link ndxToQqqLevel}; never fetches or assumes reference prices. */
export const NdxToQqqLevelInputSchema: Schema<NdxToQqqLevelInput> = schema.object({
  ndxPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in NDX index points; finite and nonnegative.'),
  referenceNdxPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in NDX index points; finite and positive.'),
  referenceQqqPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per QQQ share; finite and positive.'),
});

/** Closed three-price request for {@link qqqToNdxLevel}; never fetches or assumes reference prices. */
export const QqqToNdxLevelInputSchema: Schema<QqqToNdxLevelInput> = schema.object({
  qqqPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per QQQ share; finite and nonnegative.'),
  referenceQqqPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per QQQ share; finite and positive.'),
  referenceNdxPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in NDX index points; finite and positive.'),
});

/** Closed three-price request for {@link rutToIwmLevel}; never fetches or assumes reference prices. */
export const RutToIwmLevelInputSchema: Schema<RutToIwmLevelInput> = schema.object({
  rutPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in RUT index points; finite and nonnegative.'),
  referenceRutPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in RUT index points; finite and positive.'),
  referenceIwmPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per IWM share; finite and positive.'),
});

/** Closed three-price request for {@link iwmToRutLevel}; never fetches or assumes reference prices. */
export const IwmToRutLevelInputSchema: Schema<IwmToRutLevelInput> = schema.object({
  iwmPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per IWM share; finite and nonnegative.'),
  referenceIwmPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per IWM share; finite and positive.'),
  referenceRutPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in RUT index points; finite and positive.'),
});

/** Closed three-price request for {@link djiaToDiaLevel}; never fetches or assumes reference prices. */
export const DjiaToDiaLevelInputSchema: Schema<DjiaToDiaLevelInput> = schema.object({
  djiaPriceLevel: schema
    .number()
    .nonnegative()
    .describe(
      'Requested level in DJIA index points (full Dow Jones Industrial Average); finite and nonnegative.',
    ),
  referenceDjiaPrice: schema
    .number()
    .positive()
    .describe(
      'Comparable reference in DJIA index points (full Dow Jones Industrial Average); finite and positive.',
    ),
  referenceDiaPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per DIA share; finite and positive.'),
});

/** Closed three-price request for {@link diaToDjiaLevel}; never fetches or assumes reference prices. */
export const DiaToDjiaLevelInputSchema: Schema<DiaToDjiaLevelInput> = schema.object({
  diaPriceLevel: schema
    .number()
    .nonnegative()
    .describe('Requested level in USD per DIA share; finite and nonnegative.'),
  referenceDiaPrice: schema
    .number()
    .positive()
    .describe('Comparable reference in USD per DIA share; finite and positive.'),
  referenceDjiaPrice: schema
    .number()
    .positive()
    .describe(
      'Comparable reference in DJIA index points (full Dow Jones Industrial Average); finite and positive.',
    ),
});
