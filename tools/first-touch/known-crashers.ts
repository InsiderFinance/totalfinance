/**
 * THE RATCHET (dx 7.1) - now EMPTY, and locked empty by the sweep itself.
 *
 * This set once held 387 facade paths that escaped raw TypeErrors on the garbage-probe set; every
 * one has since gained a typed boundary guard (see the requireArgArray / requireArgObject /
 * teaching-error patterns across the package sources). The rules that got it here still stand:
 *
 *   1. This set stays EMPTY. A new raw crasher fails the sweep immediately - add a boundary guard
 *      at the facade (never an entry here).
 *   2. Any structurally natural low-level exception belongs in the sweep's EXEMPT set with a stated
 *      reason, not here; financial scalar lists never qualify merely because they are kernels.
 */
export const KNOWN_CRASHERS: ReadonlySet<string> = new Set([]);
