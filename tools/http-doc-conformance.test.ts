/**
 * The HTTP guide describes exactly what ships (Stage 7A Decision 7): every route the server serves is
 * named, every named route is served, and the status table is the server's own mapping.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiDocument, statusForError } from '@totalfinance/http';
import { registryForProfile } from '@totalfinance/workflows/local';

const GUIDE = fileURLToPath(new URL('../docs/guides/http.md', import.meta.url));
const guide = readFileSync(GUIDE, 'utf8');

/** The route templates the document publishes (per-operation run paths collapse to the template). */
function publishedRoutes(): string[] {
  const document = openApiDocument({ registry: registryForProfile({ profile: 'full' }) });
  const routes = new Set<string>();
  for (const [path, methods] of Object.entries(document.paths)) {
    const template =
      path.startsWith('/operations/') && path.endsWith('/run') ? '/operations/{id}/run' : path;
    for (const method of Object.keys(methods)) routes.add(`${method.toUpperCase()} ${template}`);
  }
  return [...routes].sort();
}

describe('HTTP guide conformance (Stage 7A)', () => {
  it('names every served route, and no route that is not served', () => {
    const named = new Set(
      [...guide.matchAll(/`(GET|POST) (\/[^`]+)`/g)].map((match) => `${match[1]} ${match[2]}`),
    );
    const served = publishedRoutes();
    for (const route of served)
      expect(named.has(route), `the guide never names \`${route}\``).toBe(true);
    const phantom = [...named].filter((route) => !served.includes(route));
    expect(
      phantom,
      `the guide names routes the server does not serve:\n${phantom.join('\n')}`,
    ).toEqual([]);
  });

  it('publishes the status mapping the server applies', () => {
    const rows = [...guide.matchAll(/^\| `(\d{3})` +\|/gm)].map((match) => Number(match[1]));
    expect(rows).toEqual([200, 400, 401, 403, 404, 409, 413, 415, 422, 500]);
    const doc = { message: '', context: {}, operation: { id: 'x', version: '1' } };
    expect(statusForError({ ...doc, code: 'input.wrong_type' } as never)).toBe(400);
    expect(statusForError({ ...doc, code: 'operation.unknown' } as never)).toBe(404);
    expect(statusForError({ ...doc, code: 'operation.cancelled' } as never)).toBe(409);
    expect(statusForError({ ...doc, code: 'operation.input_too_large' } as never)).toBe(413);
    expect(statusForError({ ...doc, code: 'backtest.mark_unavailable' } as never)).toBe(422);
    expect(statusForError({ ...doc, code: 'operation.internal' } as never)).toBe(500);
  });

  it('states the loopback default, the byte budget, and the store default', () => {
    expect(guide).toContain('127.0.0.1');
    expect(guide).toContain('--allow-non-loopback');
    expect(guide).toContain('65,536');
    expect(guide).toContain('~/.totalfinance/store');
  });

  it('teaches the implemented credential and public-read contract', () => {
    for (const term of [
      'authenticationToken: string',
      '--token-file <path>',
      'TOTALFINANCE_HTTP_TOKEN',
      'Authorization: Bearer <token>',
      'Content-Type: application/json',
      'trade:approve',
      'randomBytes(32)',
      'timingSafeEqual',
      'localBearer',
      'Origin: null',
      'jobMutations',
      'without a configured token they return 403',
      'Job reads and inline analytics stay unauthenticated',
      'The file wins when both are supplied',
    ])
      expect(guide, term).toContain(term);
    const document = openApiDocument({ registry: registryForProfile({ profile: 'full' }) });
    expect(document.components.securitySchemes['localBearer']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    for (const path of [
      '/jobs',
      '/jobs/{id}/cancel',
      '/operations/totalfinance.trade.authorize/run',
    ]) {
      expect(document.paths[path]!['post']).toMatchObject({ security: [{ localBearer: [] }] });
    }
    expect(document.paths['/operations/totalfinance.option.price/run']!['post']).toMatchObject({
      security: [],
    });
  });
});
