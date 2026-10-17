#!/usr/bin/env python3
"""Generate the extension icons from the Lexi web app's own app icons.

Source of truth: lexi-frontend's public/icons (black Lexi mark on a #FAFAFA
rounded tile, the icons app.getlexi.io uses). 48 and 128 are scaled down from
icon-512x512.png; 16 and 32 copy the web app's hand-tuned favicons. Pass a
different icons directory as argv[1] if the frontend lives elsewhere.
Requires Pillow (run via a backend venv python).
"""
import os
import sys

from PIL import Image

DEFAULT_SRC = os.path.expanduser("~/lexi/lexi-frontend/public/icons")

SOURCES = {
    16: "favicon-16x16.png",
    32: "favicon-32x32.png",
    48: "icon-512x512.png",
    128: "icon-512x512.png",
}


def main() -> None:
    src_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    for name in set(SOURCES.values()):
        if not os.path.exists(os.path.join(src_dir, name)):
            sys.exit(
                f"{name} not found in {src_dir}\n"
                "Pass lexi-frontend's public/icons directory as the first argument."
            )
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(repo, "icons")
    os.makedirs(out_dir, exist_ok=True)

    for size, name in SOURCES.items():
        src = Image.open(os.path.join(src_dir, name)).convert("RGBA")
        if src.size != (size, size):
            src = src.resize((size, size), Image.LANCZOS)
        out = os.path.join(out_dir, f"icon{size}.png")
        src.save(out, optimize=True)
        assert Image.open(out).size == (size, size)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
