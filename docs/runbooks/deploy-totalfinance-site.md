# Deploy TotalFinance's homepage and documentation

This guide publishes one TotalFinance Vercel project containing both the standalone homepage and
the documentation source files. InsiderFinance's `/totalfinance` product page and docs rewrite are
separate application work, called out below. No npm publication is required to deploy the website.

## 1. Get the site changes into GitHub

The homepage, branding and deployment configuration must be committed, reviewed and merged into
`InsiderFinance/totalfinance`'s `main` branch with the required current-head CI checks green. Local
uncommitted files do not appear in a Git-connected Vercel build. Include the generated branding
exports and documentation inventory; do not commit local `.env` files or `site/dist`.

## 2. Create the TotalFinance Vercel project

In Vercel, choose the intended team, then **Add New → Project → Import Git Repository**. Select
`InsiderFinance/totalfinance` and name the project `totalfinance` (or another available project name).
Use the repository root as the Root Directory, not `site/` or a package workspace.

Use the settings below. The checked-in `vercel.json` supplies the framework, commands and output;
select the root directory and production branch in Vercel's project settings:

| Setting           | Value                         |
| ----------------- | ----------------------------- |
| Framework Preset  | Other                         |
| Root Directory    | Repository root (`.`)         |
| Install Command   | `bash site/vercel.sh install` |
| Build Command     | `bash site/vercel.sh build`   |
| Output Directory  | `site/dist`                   |
| Production Branch | `main`                        |

Keep those commands and the output directory consistent with the file. No app credentials, API
keys, database or market-data service is needed for this static site.

The wrapper reads `.nvmrc` and `package.json`'s `packageManager` pin and runs install/build with those
exact tools. It uses npm exec only to bootstrap the pinned Node/pnpm executables; project dependencies
still install with frozen pnpm. This avoids Vercel's broad Node engine-range selection overriding
the canonical runtime. No `ENABLE_EXPERIMENTAL_COREPACK` variable is needed with this wrapper.

Choose **Deploy**. This builds the site and gives you a generated Vercel address. Adding the custom
domain comes after the initial review.

## 3. Review the generated deployment

Open the returned URL in a browser. On both desktop and a phone-sized viewport:

1. Open `/`: check the logo, layout and first-call code; use **Copy code**.
2. Open `/docs/totalfinance/`: check navigation, the logo and favicon.
3. Open `/docs/totalfinance/learn/price-an-option/`: change an input and run the calculation.
4. Open `/docs/totalfinance/search/?q=black+scholes`: open a result and check its URL stays in the docs.
5. Open `/docs/totalfinance/versions/` and follow the current snapshot's task/reference links.
6. Open `/assets/brand/og.png`: check the complete social card. Its public metadata URL uses
   `totalfinance.io`, so shared-link previews become usable once that domain is connected.
7. Request `/docs/totalfinance/reference/does-not-exist`: verify an actual HTTP 404, not the homepage.

For the last check, substitute the returned hostname:

```sh
curl -I https://YOUR-PROJECT.vercel.app/docs/totalfinance/reference/does-not-exist
```

Expect HTTP 404. The Vercel config serves only `site/dist`, has no SPA fallback, and uses slashless
routes to align with InsiderFinance's current Next.js default. The docs' trailing-slash links can
normalize once; repeated redirects indicate a routing problem to fix before launch.

Rendered mobile/keyboard review and supported-host WebMCP checks remain separate from automated
tests. Also review the Versions page: the current site evidence ledger can still label this checkout
development/unpublished even when the SDK is public. Reconcile that wording with verified SDK-only
release evidence before advertising release-matched docs; do not fabricate or bypass a receipt.

## 4. Connect totalfinance.io

Open the new project's **Settings → Domains → Add Domain** and enter `totalfinance.io`. At your
current DNS provider, add exactly the records Vercel shows for this project. Use the current shown
values rather than copying an A/CNAME target from an old guide. Keep existing unrelated DNS records.

Wait for Vercel to show valid DNS and a ready HTTPS certificate. Verify both:

- `https://totalfinance.io/`
- `https://totalfinance.io/docs/totalfinance/`

Then add `www.totalfinance.io` to the same project and configure a permanent redirect to
`https://totalfinance.io`. The apex domain is the primary address.

## 5. Connect alternate TotalFinance domains

Add each owned alternate to the same Vercel project: `totalfinance.dev`, `totalfinance.ai`, and
`totalfinance.app`. Choose a permanent redirect to `https://totalfinance.io`, rather than serving
duplicate independent sites. For each, add the DNS records Vercel requests and confirm HTTPS and the
redirect. Preserve the incoming path/query when configuring the redirect.

At this point the standalone homepage and source docs are deployed together. The InsiderFinance
product page and public docs address are still the next, separate integration.

## 6. Implement the InsiderFinance application integration

In `insiderfinance-app`, create the native `/totalfinance` landing page and link it from the desired
navigation. This page has not been built by the TotalFinance homepage change.

Append this rule to the app's existing `rewrites()` array in `next.config.js`; retain all other rules:

```js
{
  source: '/docs/totalfinance/:path*',
  destination: 'https://totalfinance.io/docs/totalfinance/:path*',
}
```

The source URL on `totalfinance.io` must continue serving docs files directly. Redirecting that
source back to InsiderFinance creates a proxy loop. Keep the asset paths under the same docs mount;
the wildcard forwards scripts, icons, styles, search and version snapshots as well as HTML.

The public docs address will be `https://www.insiderfinance.io/docs/totalfinance/`, while Vercel
fetches the files from TotalFinance's deployment. Visitors retain the InsiderFinance address.

## 7. Verify staging, then finish public docs links and indexing

Follow the app repo's review/check/deployment process to verify the changes on staging first. Check
the landing page, docs index, calculator, search, assets, version snapshots, HTTP 404s and slash
normalization through the rewrite. A successful source-site check does not prove the proxy works.

When the public InsiderFinance route is ready, update TotalFinance's homepage documentation
navigation to the InsiderFinance URL, assign docs canonical/`og:url` metadata there, and add the
appropriate docs entries to InsiderFinance's sitemap. Keep same-origin script/stylesheet URLs
working; don't replace every asset link with a cross-domain redirect. Homepage canonical/OG URLs
remain on `totalfinance.io`.

These link/canonical/sitemap changes are pending implementation, not a Vercel dashboard setting.
The two projects can subsequently deploy independently: docs edits stay in this repository.

## 8. Release the InsiderFinance changes and check the public addresses

Use the InsiderFinance production release process after review, staging checks and explicit
maintainer authorization. Its `AGENTS.md` requires an exact command/commit/branch summary and a
human yes before an agent performs a production action. This runbook does not supply that approval.

Verify the three public surfaces:

| Address                                            | Result                                |
| -------------------------------------------------- | ------------------------------------- |
| `https://totalfinance.io/`                         | Standalone TotalFinance homepage      |
| `https://www.insiderfinance.io/totalfinance`       | InsiderFinance product landing page   |
| `https://www.insiderfinance.io/docs/totalfinance/` | Docs from the TotalFinance deployment |

Check an actual shared-link preview after DNS and the public page are reachable. Social services
can cache previews, so request a refresh in the service's preview debugger after changing a card.

## References

- [Vercel build/output configuration](https://vercel.com/docs/builds/configure-a-build)
- [Vercel Node version selection](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Custom domain and DNS setup](https://vercel.com/docs/domains/set-up-custom-domain)
- [Next.js external rewrites](https://nextjs.org/docs/14/pages/api-reference/next-config-js/rewrites)
