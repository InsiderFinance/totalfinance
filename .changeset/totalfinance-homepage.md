---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Keep the original task-first TotalFinance homepage at `/`, changing only its logo and brand colors,
and expose the developer workbench under `/docs/totalfinance/` using the same layout. This changes
the website only; published package versions are unchanged.

Add the supplied brand's editable SVG recreation, favicon/Apple icons and social preview card,
plus static Vercel configuration and a step-by-step deployment guide.

Refresh the project README with homepage, documentation and npm links, a direct quickstart,
concise feature coverage and agent setup, and remove repeated version caveats.

Recover the original Next.js/Fumadocs marketing homepage and dependent site components from the
earlier design worktree. Apply the supplied TotalFinance branding, keep the documentation mount,
and remove prominent development/unpublished status banners without changing release evidence.

Finish the calculator's green control accents and fix the restored docs MCP adapter's Node ESM
startup, with a cold emitted-module regression and a Web Request entrypoint for Vercel.

Use finance in the headline, remove the unlaunched Discord link, expose the Library navigation,
clarify complete API-reference links, and use neutral code-panel colors. README documentation
links target InsiderFinance and include its linked credit.

Keep one header brand, group version/GitHub/npm links in the sidebar, and label the homepage's
documentation navigation View Docs. Explain the shared docs prefix in the deployment guide.
