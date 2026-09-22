/**
 * Volume & order-flow family (concept entrypoint).
 *
 * The core volume indicators (`./volume-core`) plus the extended set (`./volume-ext`): Archer OBV,
 * Market Facilitation Index, price-volume rank, the volume oscillator, Williams A/D, and the
 * conventional aliases (`efi`→`forceIndex`, `emv`→`easeOfMovement`, `kvo`→`klinger`). Consumers
 * import one concept — `@insiderfinance/totalfinance/technical-analysis/volume` — instead of the split modules.
 *
 * The split is a load-order concern, not a public one: `./volume-ext` re-uses core functions to
 * define its aliases, so core must be a leaf module. Keeping this barrel separate from `./volume-core`
 * avoids a `volume ↔ volume-ext` import cycle (which would leave the value aliases `undefined`).
 */
export * from './volume-core.js';
export * from './volume-ext.js';
