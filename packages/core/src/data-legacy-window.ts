/** Internal immutable v1 window restore; no legacy live provider protocol. */
import { scanCanonicalData } from './artifacts/canonical-scan.js';
import { canonicalJsonOf } from './canonical-json.js';
import { deepFreeze } from './artifacts/deep-freeze.js';
import { scanIssue, atResponse } from './data-response-issue.js';
import { object, numberField, pageData, version, requestData } from './data-validation.js';
import { responseData } from './data-call.js';
import { invalidView } from './data-view-validation.js';
import { dataSequence } from './data-sequence-validation.js';
import type { PriceBarsWindowRequest, PriceBarsWindow, PriceBarsWindowView } from './data-types.js';
import { makeWindowView } from './data-window-view.js';
function windowRequest(input: PriceBarsWindowRequest, limit: number) {
  const query = { ...input, kind: 'price-bars' as const, limit };
  requestData(query as never);
  return query as never;
}
export function legacyWindowView(input: unknown, selection?: unknown): PriceBarsWindowView {
  return responseData(() => {
    // A window contains up to100 individually bounded pages plus its header. The per-page
    // 2M scan remains enforced by pageData/createDataView below; do not apply it to their sum.
    try {
      scanCanonicalData(input, {
        functionName: 'createPriceBarsWindowView',
        label: 'window',
        requireFiniteNumbers: true,
        maximumWorkUnits: 2_000_000 * 101,
      });
    } catch (error) {
      scanIssue(error, input);
    }
    const args = object(input, 'window', ['version', 'kind', 'request', 'pages', 'pagination']);
    version(args['version']);
    if (args['kind'] !== 'price-bars-window') invalidView();
    const pagination = object(args['pagination'], 'pagination', [
      'status',
      'pageSize',
      'pageCalls',
      'records',
    ]);
    if (pagination['status'] !== 'terminal') invalidView();
    numberField(pagination['pageSize'], 'pageSize', 1, 2000, true);
    numberField(pagination['pageCalls'], 'pageCalls', 1, 100, true);
    numberField(pagination['records'], 'records', 0, 100000, true);
    const original = windowRequest(
      args['request'] as PriceBarsWindowRequest,
      pagination['pageSize'],
    );
    if (!Array.isArray(args['pages']) || args['pages'].length !== pagination['pageCalls'])
      invalidView();
    const sequence = dataSequence();
    let records = 0;
    for (let i = 0; i < args['pages'].length; i++) {
      const p = args['pages'][i];
      try {
        version(p?.contractVersion);
        pageData(p, original);
      } catch (error) {
        atResponse(error, { pageIndex: i }, 'createPriceBarsWindowView');
      }
      if ((p.nextCursor === null) !== (i === args['pages'].length - 1)) invalidView();
      sequence(p);
      records += p.data.length;
    }
    if (records !== pagination['records']) invalidView();
    const window = deepFreeze(JSON.parse(canonicalJsonOf(input)) as PriceBarsWindow);
    return makeWindowView(window, selection);
  });
}
