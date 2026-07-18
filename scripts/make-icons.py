#!/usr/bin/env python3
"""Generate extension icons from the official Lexi app icon.

Source of truth: the marketing "App Icon" package (Asset 3 = white mark on
teal rounded square). Pass a different source path as argv[1] if the
marketing assets live elsewhere. Requires Pillow (run via the donna-backend
venv python).
"""
import os
import sys

from PIL import Image

DEFAULT_SRC = (
    "/Users/harshitgarg/Documents/Lexi/Marketing/Fiver/V_final/"
    "Lexi_Project_Final_Files/App Icon/PNG/Asset 3.png"
)

def main() -> None:
    src_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.exists(src_path):
        sys.exit(
            f"source logo not found: {src_path}\n"
            "Pass the path to the official 'Asset 3.png' as the first argument."
        )
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(repo, "icons")
    os.makedirs(out_dir, exist_ok=True)

    src = Image.open(src_path).convert("RGBA")
    side = min(src.size)  # center-crop to square (source is ~911x912)
    left = (src.width - side) // 2
    top = (src.height - side) // 2
    src = src.crop((left, top, left + side, top + side))

    for size in (16, 32, 48, 128):
        out = os.path.join(out_dir, f"icon{size}.png")
        src.resize((size, size), Image.LANCZOS).save(out)
        assert Image.open(out).size == (size, size)
        print(f"wrote {out}")

if __name__ == "__main__":
    main()
