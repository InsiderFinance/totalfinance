# TotalFinance brand assets

The maintainer supplied the original mark on 2026-11-12: green code braces around ascending bars.
All three supplied PNGs are preserved unchanged as `source/original-logo-white.png`,
`source/original-logo.png` (tight transparent variant), and `source/original-logo-square.png`.
`source/logo.svg` is a
clean, editable vector recreation, not an assertion that the original PNG was losslessly converted.
It contains real paths/gradients and no embedded raster image, script or external resource.

`source/og-template.svg` owns the social-card composition and editable text. `generate.py` embeds
the vector mark with unique IDs, then exports the checked-in files under `assets/`:

- `logo.svg`: transparent vector mark used in the homepage.
- `favicon.svg`, `favicon-32.png`, `favicon.ico`: browser icons; ICO contains 16, 32 and 48px images.
- `apple-touch-icon.png`: opaque 180×180 icon.
- `icon-192.png`, `icon-512.png`: larger square icon exports.
- `og.svg`, `og.png`: self-contained 1200×630 social card. Metadata uses the PNG for social crawlers.

The social card reads **“The most complete finance toolkit.”**, **“For developers and AI agents.”**,
and **“Built with TypeScript. Run anywhere.”** Its sharing title/description and image alt text
use the same message. The homepage's on-page hero remains its own presentation.

Regenerate after changing the SVG sources, using the pinned optional export tools:

```sh
uv run --with cairosvg==2.8.2 --with pillow==11.3.0 python site/brand/generate.py
```

CairoSVG requires Cairo. On a Homebrew Mac where the library lookup needs its location:

```sh
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --with cairosvg==2.8.2 --with pillow==11.3.0 python site/brand/generate.py
```

Inspect the exported icons and card after regeneration. The site build copies these reviewed assets;
it does not install Python tools or regenerate images on Vercel. Do not hand-edit exported PNG/ICO
files. The documentation assets, including icons, are copied into self-contained version snapshots.

The homepage canonical and absolute social-image origin are `https://totalfinance.io`. Docs currently
have page-specific sharing titles/descriptions and the same card, without claiming the pending
InsiderFinance canonical integration has shipped.
