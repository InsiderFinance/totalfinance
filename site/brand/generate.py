"""Export website branding from the editable SVG sources; never modify the original PNG."""

from io import BytesIO
from pathlib import Path
import re
import subprocess

from cairosvg import svg2png
from PIL import Image

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "source"
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

logo = (SOURCE / "logo.svg").read_text()
inner = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", logo).strip()
(OUT / "logo.svg").write_text(logo)

favicon = (
    '<svg xmlns="http://www.w3.org/2000/svg" '
    'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024">'
    '<rect width="1024" height="1024" rx="192" fill="#fafbf8"/>'
    f'<g transform="translate(10 10) scale(.98)">{inner}</g></svg>\n'
)
(OUT / "favicon.svg").write_text(favicon)
for name, size in [
    ("favicon-32.png", 32),
    ("apple-touch-icon.png", 180),
    ("icon-192.png", 192),
    ("icon-512.png", 512),
]:
    artwork = favicon.replace('rx="192"', 'rx="0"') if name == "apple-touch-icon.png" else favicon
    svg2png(bytestring=artwork.encode(), write_to=str(OUT / name), output_width=size, output_height=size)

icon = svg2png(bytestring=favicon.encode(), output_width=256, output_height=256)
Image.open(BytesIO(icon)).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

# Prefix SVG ids for each embedded mark so the card is self-contained and ids remain unique.
def embedded_logo(index: int) -> str:
    return re.sub(r'([#"])([a-z]+-(?:green|brace|clip))(?=["\)])', rf'\g<1>mark{index}-\2', inner)

template = (SOURCE / "og-template.svg").read_text()
for index in range(template.count("<!-- LOGO -->")):
    template = template.replace("<!-- LOGO -->", embedded_logo(index), 1)
(OUT / "og.svg").write_text(template)
svg2png(bytestring=template.encode(), write_to=str(OUT / "og.png"))
subprocess.run(
    ["pnpm", "exec", "prettier", "--parser", "html", "--write", *[str(OUT / name) for name in ["logo.svg", "favicon.svg", "og.svg"]]],
    cwd=ROOT.parent.parent,
    check=True,
)
print(f"Brand assets exported to {OUT}")
