# ADR 0001 - Runtime Schema Strategy

- Status: **Accepted** (0.0.1 architecture spike)
- Date: 2026-06-20
- Deciders: TotalFinance maintainers
- Supersedes: none
- Related: spec section 6 (Runtime Schemas and Validation), section 21.5 (Bundle Size Budgets)

## Context

TotalFinance must expose runtime schemas for public payloads. They power:

- MCP tool input and output schemas
- data-adapter boundary validation
- documentation generation
- user-facing validated wrappers

The hard constraints:

1. `@totalfinance/core` and browser-safe compute packages must have zero runtime dependencies.
2. Hot compute entrypoints must not import validator code.
3. TypeScript inference through `Infer<typeof schema>` is a product feature.
4. JSON Schema export is required for MCP.
5. Errors must map to `InputError` with stable codes.
6. The choice must remain swappable; TotalFinance should not expose Zod, Valibot, or any other library as its public schema API.

## Options Considered

| Option                 | Zero-dep | JSON Schema             | Inference | Bundle cost          | Swappable        | Notes                      |
| ---------------------- | -------- | ----------------------- | --------- | -------------------- | ---------------- | -------------------------- |
| Zod                    | No       | via extra package       | excellent | largest              | behind facade    | incumbent ecosystem choice |
| Zod Mini / Zod v4 core | No       | partial                 | excellent | smaller than Zod     | behind facade    | promising, newer surface   |
| Valibot                | No       | via extra package       | excellent | small and modular    | behind facade    | strong runner-up           |
| Tiny homegrown facade  | Yes      | native `toJSONSchema()` | excellent | 3.1 KB gzip measured | it is the facade | maintenance burden         |

## Decision

Adopt a tiny, zero-dependency homegrown schema facade for `0.0.1`: `@totalfinance/core/schema`, builder `s`.

This is not a general validation framework. It implements the surface TotalFinance currently needs:

- `s.object`
- `s.number`
- `s.string`
- `s.boolean`
- `s.enum`
- `s.literal`
- `s.array`
- `s.union`
- `parse`
- `safeParse`
- `toJSONSchema`
- Standard Schema compatibility through `~standard`
- validation modes: `strict`, `coerce`, `passthrough`, `off`

## Why It Won The Spike

Measured bundle sizes with esbuild, minified and gzipped:

| Entrypoint                            |   Gzip | Schema present? |
| ------------------------------------- | -----: | --------------- |
| `@totalfinance/options/black-scholes` | 3.0 KB | no              |
| `@totalfinance/core`                  | 1.5 KB | no              |
| `@totalfinance/core/schema`           | 3.1 KB | yes             |
| `@totalfinance/math`                  | 1.6 KB | no              |

The decisive findings:

1. The zero-dependency guarantee is only satisfied by a homegrown facade.
2. The hot-path rule holds because schema code lives behind a separate entrypoint.
3. Native JSON Schema output avoids a second converter dependency.
4. Inference and optional-property behavior are under TotalFinance control.

## Maintenance Boundaries

The risk is scope creep. The boundary is:

- New schema combinators require an ADR update.
- Public callers depend on `Schema<T>`, `parse`, `safeParse`, `toJSONSchema`, and `~standard`, not the internal implementation.
- If the facade outgrows its mandate, it can be reimplemented on top of Valibot or Zod behind the same public boundary.

## Consequences

- `@totalfinance/core` keeps zero runtime dependencies.
- Compute entrypoints stay within bundle budget.
- MCP tools generate input schemas from the same source used for validation.
- TotalFinance owns a small validator implementation.

## Revisit Triggers

Re-open this ADR if:

- the facade exceeds about 6 KB gzip or 600 LOC
- recursive or mutually-referential schemas are needed
- async validation is needed
- JSON Schema fidelity needs exceed the current direct emitter
- a mature external library can satisfy the same constraints without exposing itself in TotalFinance's public API
