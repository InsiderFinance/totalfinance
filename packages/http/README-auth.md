## Local server and authentication

Read-only analytics and discovery work without a token. Enabled writes (including `trade:approve`,
which persists grants) and job creation/cancellation require a server-owned bearer credential.

Create a protected token file without printing the secret or placing it in command-line arguments:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(".totalfinance-http-token", randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });'
pnpm exec totalfinance-http --profile full --token-file .totalfinance-http-token
```

Keep the token file outside version control. This enables authenticated jobs, not trade capabilities.
To enable writes, add the needed repeatable `--capability <name>` flags; an explicit capability list
replaces the defaults. The [HTTP guide](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guides/http.md)
includes a complete capability list and an authenticated request example.

In process, set `createLocalHttpServer({ registry, authenticationToken, ... })`. The token must contain
at least 32 random bearer-token characters. CLI `--token-file <path>` overrides `TOTALFINANCE_HTTP_TOKEN`;
there is no `--token` argument. Clients send `Authorization: Bearer <token>` and, for JSON POSTs,
`Content-Type: application/json`. Without a configured token, job submission/cancellation are disabled
but job reads remain available. A token never grants a missing capability.

Host and any Origin must name this server and its bound port; foreign and `null` origins are refused.
Omit Origin for ordinary non-browser clients. Discovery and logs never publish the credential.
