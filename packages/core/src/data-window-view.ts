/** Shared pure terminal view owner; no binding, discovery or acquisition dependency. */
import type { PriceBarsWindow, PriceBarsWindowView, ResearchBarChoice } from './data-types.js';
import { researchSelection, appendChoice } from './data-selection.js';
/** Construct a terminal view; strict selection remains lazy and all page facts survive. */
export function makeWindowView(window: PriceBarsWindow, selection?: unknown): PriceBarsWindowView {
  const state = researchSelection(window.pages, selection);
  return Object.freeze(
    Object.defineProperties(
      { kind: 'price-bars-window' as const, window },
      {
        ...state.descriptors(),
        resolve: {
          value: (choice: ResearchBarChoice) =>
            makeWindowView(window, appendChoice(window.pages, state.selection, choice)),
        },
      },
    ),
  ) as PriceBarsWindowView;
}
