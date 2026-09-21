/**
 * Stage 7A slice 5 — first-touch fixtures for `@totalfinance/http`: the OpenAPI generator over a small
 * registry, a server that is created but never listens (a fresh `port: 0` object), and the status
 * mapper. Thunks build FRESH inputs per call.
 */

import { createOperationRegistry, optionsPack } from '@totalfinance/workflows';
import { type FixtureThunk } from '../inputs.js';

const registry = () => createOperationRegistry({ packs: [optionsPack()] });

export const HTTP_FIXTURES: Record<string, FixtureThunk> = {
  'http.openApiDocument': () => [{ registry: registry(), serverUrl: 'http://127.0.0.1:8787' }],
  'http.createLocalHttpServer': () => [{ registry: registry(), port: 0 }],
  'http.statusForError': () => [
    {
      code: 'operation.unknown',
      message: 'fixture',
      context: {},
      operation: { id: 'totalfinance.fixture.echo', version: '1' },
    },
  ],
};
