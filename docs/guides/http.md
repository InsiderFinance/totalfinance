# Local HTTP server

`@insiderfinance/totalfinance` ships `totalfinance-http` (embedded API at `/http`): a loopback, read-only-by-default HTTP server over the same
operation registry every transport adapts (`@insiderfinance/totalfinance/workflows`), and `openApiDocument`, the OpenAPI
3.1 document generated from that registry. The server owns no schema and no compute — every request body
is the operation's own input schema, every success body is the `OperationResult`, and every error body is
one `OperationError` (the same document the CLI prints and the MCP server returns).

## Quickstart

```sh
pnpm --package=@insiderfinance/totalfinance@0.1.0 dlx totalfinance-http --port 8787 --profile full --store ~/.totalfinance/store
# In another terminal (no token needed for discovery or inline analytics):
curl -s http://127.0.0.1:8787/operations | jq '.[].id'
curl -s -X POST http://127.0.0.1:8787/operations/totalfinance.option.price/run \
  -H 'content-type: application/json' \
  -d '{"type":"call","spot":100,"strike":105,"timeToExpiryYears":0.25,"riskFreeRate":0.04,"volatility":0.2}'
pnpm --package=@insiderfinance/totalfinance@0.1.0 dlx totalfinance-http --openapi > openapi.json
```

The server binds `127.0.0.1` by default. `localhost` and IPv6 `::1` / `[::1]` are also loopback;
IPv6 URLs use brackets, such as `http://[::1]:8787`. A non-loopback bind needs
`--allow-non-loopback` and your own network/TLS boundary: read endpoints remain public, and this
server does not provide TLS or remote multi-user access control.

## Authentication and enabled writes

Configure a server-owned token before enabling any write operation. This includes `trade:approve`:
approval persists a grant even though its operation metadata says `sideEffect: none`. Authentication
does not grant capabilities; the server's explicit capability list remains the ceiling.

The SDK option is `authenticationToken: string`. Use at least 32 cryptographically random characters
from the bearer alphabet (`A–Z`, `a–z`, `0–9`, `-._~+/`, optionally followed by `=` padding).
`randomBytes(32).toString('hex')` supplies 64 suitable characters. Length validation cannot prove
randomness; use a secure generator, not a memorable password.

For the CLI, use `--token-file <path>` or a protected `TOTALFINANCE_HTTP_TOKEN` environment variable.
The file wins when both are supplied. The file reader removes one trailing LF or CRLF; the
environment variable and SDK value are used exactly, without trimming. Empty or invalid tokens are
refused. There is no secret-valued `--token` argument. Do not put tokens in URLs, shell history,
command-line arguments, logs, or version control.

Create a new owner-readable token file, without printing the credential or overwriting an existing
one, then start a server with the default analytics capabilities and the three write capabilities:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(".totalfinance-http-token", randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });'
pnpm --package=@insiderfinance/totalfinance@0.1.0 dlx totalfinance-http --profile full --token-file .totalfinance-http-token \
  --capability portfolio:read --capability analytics:run --capability trade:propose \
  --capability trade:approve --capability trade:paper --capability portfolio:write
```

Only enable the capabilities you need. Repeated `--capability` flags **replace**, rather than extend,
the defaults. For authenticated analytics jobs alone, omit all `--capability` flags and keep the
token. When using the environment instead, have your secret manager or process launcher supply
`TOTALFINANCE_HTTP_TOKEN` and omit `--token-file`.

In another terminal, this client reads the same protected file and submits an analytics job. The
secret never becomes a process argument. The same headers protect an enabled write's inline run:

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const token = readFileSync('.totalfinance-http-token', 'utf8').replace(/\r?\n$/, '');
const response = await fetch('http://127.0.0.1:8787/jobs', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    id: 'totalfinance.option.price',
    input: {
      type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25,
      riskFreeRate: 0.04, volatility: 0.2,
    },
  }),
});
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
console.log(await response.json());
JS
```

Every enabled write and `POST /jobs` / `POST /jobs/{id}/cancel` requires
`Authorization: Bearer <token>`. Bearer values are compared with `timingSafeEqual`. JSON POSTs need
`Content-Type: application/json` (a charset parameter is accepted). Cancellation needs no body or
content-type header. Host, Origin, capability, and bearer refusals precede JSON parsing for inline
writes; job creation authenticates before parsing its envelope.

Job submission/cancellation mutate persisted state even when the job computes read-only analytics,
so without a configured token they return 403. Job reads and inline analytics stay unauthenticated.
An attached artifact store may still cache/spill public analytics results: `readOnly` describes
enabled operation effects and job lifecycle mutations, not result caching.

`GET /capabilities` reports `authentication.configured`, `jobMutations`, and `readOnly`; no secret is
returned. `readOnly` is false when a write operation is enabled or authenticated job mutations are
available. OpenAPI declares the HTTP bearer scheme `localBearer` on write and job-mutation routes,
including approval; it does not require authentication on read-only analytics/discovery. Neither
OpenAPI, capabilities, the CLI listening line, nor server logs publish the token. Restart with a new
token to rotate it, and update trusted clients.

## Request boundary

Every request needs a Host naming the configured server (or its bound local address) and its actual
bound port. On loopback binds, `127.0.0.1`, `localhost`, and `[::1]` are accepted aliases; an ephemeral
port must match the address returned by `start()` or the CLI listening line. Arbitrary hostnames and
forwarded-host headers do not bypass this check.

Ordinary non-browser clients should omit Origin. If present, it must be this server's `http://` origin
with a trusted host and the same port. Foreign origins, different ports, `Origin: null`, and duplicate
security headers are refused; a correct bearer token does not bypass these checks. Missing permissive
CORS headers are not the safety boundary.

Malformed targets or percent encodings receive a structured 400, and the server keeps serving.
Encoded separators are refused in operation/job route segments; URL-encoded artifact URIs remain
supported, including their embedded slashes.

## Routes

| Route                       | What it does                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /openapi.json`         | this document, generated from the running registry                                                   |
| `GET /capabilities`         | packs and operation count, the resolved budgets, the seed policy, which stores are attached          |
| `GET /operations`           | every operation's description (`describeOperation`)                                                  |
| `GET /operations/{id}`      | one description                                                                                      |
| `POST /operations/{id}/run` | run inline; the body is the operation's input; the response is the `OperationResult`                 |
| `POST /jobs`                | `{ id, input, seed? }` — a job-class operation runs in a worker (202 with the record), others inline |
| `GET /jobs/{id}`            | the job record (poll it; there is no streaming in this stage)                                        |
| `POST /jobs/{id}/cancel`    | cancel — the worker is terminated and the record moves to `cancelled`                                |
| `GET /jobs/{id}/result`     | the stored `OperationResult` of a completed job                                                      |
| `GET /artifacts/{uri}`      | `{ handle, value }` for a url-encoded `totalfinance://…` handle                                      |

The CLI attaches jobs and artifacts through its store directory (`--store`, default `~/.totalfinance/store`).
An in-process server needs the corresponding injected store/runner; without one the server answers
those routes with a teaching instead of pretending. A token is additionally required for job mutations.

## Status codes

| Status | When                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | success (`202` for an accepted job)                                                                                                                      |
| `400`  | the input was refused — an `input.*` code                                                                                                                |
| `401`  | a configured mutation credential is missing or invalid (`operation.capability_missing`; `WWW-Authenticate: Bearer realm="@insiderfinance/totalfinance"`) |
| `403`  | Host/Origin refused (`input.wrong_shape`), missing server capability, or job mutations disabled without a token (`operation.capability_missing`)         |
| `404`  | unknown operation, job, handle, or route (`operation.unknown`, `operation.handle_unknown`)                                                               |
| `409`  | the job was cancelled, or has no result yet (`operation.cancelled`)                                                                                      |
| `413`  | the body exceeds the wire byte budget (`operation.input_too_large`; default 65,536 bytes)                                                                |
| `415`  | a JSON POST lacks `Content-Type: application/json` (`input.wrong_shape`)                                                                                 |
| `422`  | any other operation error (the compute's own typed refusal)                                                                                              |
| `500`  | internal (`operation.internal`)                                                                                                                          |

Every response carries `X-Request-Id` (yours, echoed, or a generated one) and the result's
`trace.requestId` matches it.

These HTTP boundary statuses are chosen by the transport. `statusForError` remains the mapper for
ordinary operation failures; an error code alone cannot distinguish 401 from 403, or 400 from 415.

## Flags

| Flag                                                           | Meaning                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `--port <n>` · `--host <name>`                                 | where to bind (default `127.0.0.1:8787`)                                                   |
| `--openapi`                                                    | print the OpenAPI document and exit                                                        |
| `--profile default\|options\|research\|full`                   | the registry profile; `--packs a,b` narrows it                                             |
| `--store <dir>`                                                | the artifact and job store directory (attaches handles and jobs)                           |
| `--token-file <path>`                                          | protected bearer-token file; overrides `TOTALFINANCE_HTTP_TOKEN`                           |
| `--capability <name>`                                          | repeatable server capability; explicit lists replace defaults; writes also require a token |
| `--max-input-bytes <n>` · `--seed <int>` · `--deadline-ms <n>` | the transport budgets and the default seed                                                 |
| `--allow-non-loopback`                                         | bind a non-loopback host                                                                   |

## In process

```ts
import { createLocalHttpServer } from '@insiderfinance/totalfinance/http';
import { createOperationRegistry, defaultPacks } from '@insiderfinance/totalfinance/workflows';

const local = createLocalHttpServer({
  registry: createOperationRegistry({ packs: defaultPacks() }),
  port: 0,
});
const { url } = await local.start(); // port 0 picks a free port
// … fetch(`${url}/operations`) …
await local.stop();
```

Pass `artifacts` (a store) and `jobs` (a `JobRunner` — `createLocalJobRunner` from
`@insiderfinance/totalfinance/workflows/local`, or your own) to attach handles and jobs. Add `authenticationToken` to
enable job mutations. To enable approval in process:

```ts
import { randomBytes } from 'node:crypto';
import { createLocalHttpServer } from '@insiderfinance/totalfinance/http';
import {
  createOperationRegistry,
  defaultPacks,
  tradePack,
  createMemoryAuthorizationStore,
  DEFAULT_CAPABILITIES,
} from '@insiderfinance/totalfinance/workflows';

const authenticationToken = randomBytes(32).toString('hex'); // share privately with trusted clients
const local = createLocalHttpServer({
  registry: createOperationRegistry({ packs: [...defaultPacks(), tradePack()] }),
  capabilities: [...DEFAULT_CAPABILITIES, 'trade:approve'],
  authenticationToken,
  stores: { authorization: createMemoryAuthorizationStore() },
  port: 0,
});
const { url } = await local.start();
// A trusted client's POST to `${url}/operations/totalfinance.trade.authorize/run` must send:
const headers = {
  Authorization: `Bearer ${authenticationToken}`,
  'Content-Type': 'application/json',
};
// Supply the operation's real input; a bearer token does not replace preflight/policy validation.
await local.stop();
```

The memory store is illustrative; inject durable lifecycle stores for approval across restarts.
The SDK token is explicit: `createLocalHttpServer` does not read environment variables for you.
