export interface SearchRecord {
  title: string;
  url: string;
  description: string;
  category: string;
  keywords: string;
  /** Generated declaration kind, or task/guide; optional for archived indexes. */
  kind?: string;
}

function normalize(text: string): string {
  return text
    .replace(/p\s*&\s*l/gi, 'pnl')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const compact = (text: string): string => text.replaceAll(' ', '');

// Reuse normalization between keystrokes without retaining discarded version indexes.
const prepared = new WeakMap<readonly SearchRecord[], ReturnType<typeof prepare>>();
function prepare(records: readonly SearchRecord[]) {
  return records.map((record, index) => {
    const title = normalize(record.title);
    const description = normalize(record.description);
    const keywords = normalize(`${record.category} ${record.keywords}`);
    return {
      record,
      index,
      title,
      compactTitle: compact(title),
      description,
      haystack: `${title} ${description} ${keywords} ${compact(title)} ${compact(keywords)}`,
    };
  });
}

export function search(
  records: readonly SearchRecord[],
  query: string,
  limit = 30,
): SearchRecord[] {
  const normalized = normalize(query);
  if (!normalized || limit <= 0) return [];
  const literal = query.trim().toLocaleLowerCase('en-US');
  const terms = [...new Set(normalized.split(' '))];
  let rows = prepared.get(records);
  if (!rows) {
    rows = prepare(records);
    prepared.set(records, rows);
  }
  return rows
    .map(({ record, index, title, compactTitle, description, haystack }) => {
      if (!terms.every((term) => haystack.includes(term))) return { record, index, score: 0 };
      // Match quality wins before kind. An explicitly requested input type must still be first.
      const titleMatches = terms.every(
        (term) => title.includes(term) || compactTitle.includes(term),
      );
      const relevance =
        record.title.toLocaleLowerCase('en-US') === literal
          ? 1200
          : compactTitle === compact(normalized)
            ? 1000
            : record.kind === 'task' && normalize(record.keywords) === normalized
              ? 900
              : titleMatches
                ? 600 + 100 * Math.min(1, terms.length / title.split(' ').length)
                : terms.every((term) => description.includes(term))
                  ? 350
                  : terms.every((term) => `${title} ${description}`.includes(term))
                    ? 300
                    : 100;
      const kind = record.kind;
      const usefulness =
        kind === 'function' || kind === 'operation'
          ? 80
          : kind === 'task'
            ? 70
            : kind === 'guide'
              ? 60
              : 0;
      return { record, index, score: relevance + usefulness };
    })
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Keep every distinct import available; prefer a domain entry point over the root alias.
        Number(a.record.category === '@insiderfinance/totalfinance') -
          Number(b.record.category === '@insiderfinance/totalfinance') ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map((row) => row.record);
}
