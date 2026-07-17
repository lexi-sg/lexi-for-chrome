#!/usr/bin/env python3
"""
Generates the Lexi for Chrome extension icons.

Design: a rounded-square Lexi-indigo (#4F46E5) background with a bold,
sans-serif white "L" monogram rendered as simple geometric bars. Drawn at
a large master size (512px) with anti-aliasing (via 4x supersampling)
then LANCZOS-downscaled to each target icon size, so edges stay crisp
even at 16px.

Run with the backend venv's Python (has Pillow):
    /Users/harshitgarg/Documents/Lexi/Code.nosync/donna-backend/venv/bin/python \
        scripts/make-icons.py

Outputs (relative to repo root):
    icons/icon16.png
    icons/icon32.png
    icons/icon48.png
    icons/icon128.png
"""

import os

from PIL import Image, ImageDraw

# Lexi indigo brand color for the extension mark.
BG_COLOR = (79, 70, 229, 255)  # #4F46E5
FG_COLOR = (255, 255, 255, 255)  # white monogram

MASTER_SIZE = 512
SUPERSAMPLE = 4  # render at 4x then downscale for clean anti-aliasing
RENDER_SIZE = MASTER_SIZE * SUPERSAMPLE

TARGET_SIZES = (16, 32, 48, 128)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(REPO_ROOT, "icons")


def draw_master_icon(size: int) -> Image.Image:
    """Draw the Lexi mark at `size`x`size` (square, no alpha padding)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded-square background.
    corner_radius = round(size * 0.22)
    draw.rounded_rectangle(
        [(0, 0), (size - 1, size - 1)],
        radius=corner_radius,
        fill=BG_COLOR,
    )

    # Bold geometric "L" monogram, built from two rounded bars that
    # overlap at the joint so only the two outer ends show rounding.
    thickness = round(size * 0.16)
    bar_radius = round(thickness * 0.22)

    left = round(size * 0.30)
    right = round(size * 0.70)
    top = round(size * 0.22)
    bottom = round(size * 0.78)

    # Vertical stroke of the L.
    draw.rounded_rectangle(
        [(left, top), (left + thickness, bottom)],
        radius=bar_radius,
        fill=FG_COLOR,
    )

    # Horizontal stroke of the L.
    draw.rounded_rectangle(
        [(left, bottom - thickness), (right, bottom)],
        radius=bar_radius,
        fill=FG_COLOR,
    )

    return img


def main() -> None:
    os.makedirs(ICONS_DIR, exist_ok=True)

    master = draw_master_icon(RENDER_SIZE)

    for target in TARGET_SIZES:
        resized = master.resize((target, target), Image.LANCZOS)
        out_path = os.path.join(ICONS_DIR, f"icon{target}.png")
        resized.save(out_path, format="PNG")
        print(f"wrote {out_path} ({resized.size[0]}x{resized.size[1]})")


if __name__ == "__main__":
    main()
