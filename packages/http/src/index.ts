/**
 * `@insiderfinance/totalfinance/http` — the local HTTP transport over the TotalFinance operation registry (Stage 7A):
 * the OpenAPI 3.1 document generated from the registry, and the loopback read-only server behind
 * the `totalfinance-http` binary. It owns no schema and no compute.
 */

export { openApiDocument } from './openapi.js';
export type { OpenApiDocument, OpenApiDocumentInput } from './openapi.js';
export { createLocalHttpServer, statusForError } from './server.js';
export type { LocalHttpServer, LocalHttpServerBudgets, LocalHttpServerInput } from './server.js';
