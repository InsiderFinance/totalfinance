/** Opaque, server-bound catalog cursors. No cache or process-global paging state. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export function catalogPager(pageSize: number) {
  const key = randomBytes(32);
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest();
  return <T>(scope: string, entries: readonly T[], cursor?: string) => {
    const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    let offset = 0;
    if (cursor !== undefined) {
      const invalid = () =>
        new McpError(
          ErrorCode.InvalidParams,
          'Invalid catalog cursor: malformed, stale, or from another catalog/server. Restart listing without a cursor.',
          { cursor, catalog: scope },
        );
      if (
        typeof cursor !== 'string' ||
        cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)
      )
        throw invalid();
      const [payload, signature] = cursor.split('.') as [string, string];
      const supplied = Buffer.from(signature, 'base64url');
      const expected = sign(payload);
      if (
        supplied.toString('base64url') !== signature ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw invalid();
      let decoded: unknown;
      try {
        const bytes = Buffer.from(payload, 'base64url');
        if (bytes.toString('base64url') !== payload) throw invalid();
        decoded = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw invalid();
      }
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 4 ||
        decoded[0] !== 1 ||
        decoded[1] !== scope ||
        decoded[2] !== fingerprint ||
        !Number.isSafeInteger(decoded[3]) ||
        decoded[3] <= 0 ||
        decoded[3] >= entries.length ||
        decoded[3] % pageSize !== 0
      )
        throw invalid();
      offset = decoded[3] as number;
    }
    const end = offset + pageSize;
    const payload = Buffer.from(JSON.stringify([1, scope, fingerprint, end])).toString('base64url');
    return {
      entries: entries.slice(offset, end),
      ...(end < entries.length
        ? { nextCursor: `${payload}.${sign(payload).toString('base64url')}` }
        : {}),
    };
  };
}
