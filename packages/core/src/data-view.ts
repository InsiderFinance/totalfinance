/** SDK-owned immutable page sample with deliberate field selection and retained facts. */
import type {
  DataPage,
  DataView,
  PriceBarRecord,
  OptionChainResearchRecord,
  ResearchBarChoice,
} from './data-types.js';
import { pageData } from './data-validation.js';
import { validateV2Page, continuationOf, freezeData } from './data-protocol.js';
import { researchSelection, appendChoice } from './data-selection.js';
import { issueOf, responseIssue } from './data-response-issue.js';
export function dataViewOf(
  page: DataPage<PriceBarRecord | OptionChainResearchRecord>,
  input?: unknown,
): DataView {
  const continuation = continuationOf(page),
    continuationStatus = continuation
      ? 'available'
      : page.nextCursor === null
        ? 'terminal'
        : 'unavailable-legacy-context';
  if (page.kind === 'option-chain-research')
    return Object.freeze({
      kind: page.kind,
      page: page as DataPage<OptionChainResearchRecord>,
      continuation,
      continuationStatus,
    });
  const raw = page as DataPage<PriceBarRecord>,
    state = researchSelection([raw], input);
  return Object.freeze(
    Object.defineProperties(
      { kind: 'price-bars' as const, page: raw, continuation, continuationStatus },
      {
        ...state.descriptors(),
        resolve: {
          value: (choice: ResearchBarChoice) =>
            dataViewOf(raw, appendChoice([raw], state.selection, choice)),
        },
      },
    ),
  ) as DataView;
}
/** Restore canonical page facts and choices; never infer missing v1 query/provider context. */
export function createDataView(input: unknown, selection?: unknown): DataView {
  try {
    pageData(input);
    const page = input as DataPage<PriceBarRecord | OptionChainResearchRecord>;
    if (page.contractVersion === 2) validateV2Page(page);
    return dataViewOf(freezeData(page), selection);
  } catch (error) {
    const detail = issueOf(error);
    if (detail) responseIssue(detail, 'createDataView');
    throw error;
  }
}
