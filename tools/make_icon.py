#!/usr/bin/env python3
"""
Icon generator for Alibaba Supplier Compare.

Pure Python standard library only: no Pillow, no pip, no ImageMagick. Output is
a real RGBA PNG written by hand with zlib + struct.

Usage:
    python3 tools/make_icon.py            # writes all four sizes into icons/
    python3 tools/make_icon.py 128 out.png # one size, custom path

Design note: three ascending bars on a navy-to-teal gradient. The bars are the
comparison matrix; the ascending rhythm is the "more suppliers, better decision"
promise. Deliberately not Alibaba orange, and deliberately not the paper-plane
used by other extensions in this workspace.
"""

import math
import os
import struct
import sys
import zlib

# --------------------------------------------------------------------- png

def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: str, w: int, h: int, pixels: bytearray) -> None:
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0
        raw += pixels[y * stride:(y + 1) * stride]
    body = (b'\x89PNG\r\n\x1a\n'
            + _chunk(b'IHDR', ihdr)
            + _chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + _chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(body)


# ------------------------------------------------------------------ helpers

def lerp(a, b, t):
    return (int(a[0] + (b[0] - a[0]) * t),
            int(a[1] + (b[1] - a[1]) * t),
            int(a[2] + (b[2] - a[2]) * t))


def sdf_round_rect(px, py, x0, y0, x1, y1, r):
    """Signed distance to a rounded rectangle. Negative means inside."""
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return math.hypot(px - cx, py - cy) - r


def sdf_round_rect_bottom(px, py, x0, y0, x1, y1, r):
    """Signed distance to a rectangle with square top corners and rounded
    bottom corners. Negative means inside.

    Every region must be rejected explicitly; a naive clamp-and-measure treats
    points above the rectangle as inside because the clamped centre sits level
    with them.
    """
    if py < y0:
        return y0 - py
    if px < x0:
        return x0 - px
    if px > x1:
        return px - x1
    if py <= y1 - r:
        return -1.0  # inside the straight part of the rectangle
    cx = min(max(px, x0 + r), x1 - r)
    cy = y1 - r
    return math.hypot(px - cx, py - cy) - r


# -------------------------------------------------------------------- build

def build(size: int) -> bytearray:
    top = (18, 36, 58)        # deep navy
    bottom = (14, 124, 107)   # teal
    white = (255, 255, 255)
    mint = (168, 234, 220)    # focal accent on the middle bar

    canvas_r = 0.22 * size

    # Three ascending bars sitting on a common baseline.
    baseline = 0.735 * size
    bar_w = 0.105 * size
    gap = 0.062 * size
    heights = [0.185, 0.295, 0.405]
    total_w = 3 * bar_w + 2 * gap
    left = (size - total_w) / 2.0
    bar_r = bar_w * 0.34

    bars = []
    for i, hfrac in enumerate(heights):
        x0 = left + i * (bar_w + gap)
        bars.append((x0, baseline - hfrac * size, x0 + bar_w, baseline,
                     mint if i == 1 else white))

    ss = 3  # 3x3 supersample
    offsets = [(dx / ss, dy / ss) for dx in range(ss) for dy in range(ss)]
    px = bytearray(size * size * 4)

    for y in range(size):
        for x in range(size):
            r_sum = g_sum = b_sum = 0
            hits = 0
            for dx, dy in offsets:
                sx, sy = x + dx, y + dy
                if sdf_round_rect(sx, sy, 0, 0, size, size, canvas_r) > 0:
                    continue
                hits += 1
                colour = None
                for x0, y0, x1, y1, c in bars:
                    if sdf_round_rect_bottom(sx, sy, x0, y0, x1, y1, bar_r) <= 0:
                        colour = c
                        break
                if colour is None:
                    colour = lerp(top, bottom, sy / size)
                r_sum += colour[0]
                g_sum += colour[1]
                b_sum += colour[2]

            if hits == 0:
                continue

            # Average colour over the samples that actually landed on the
            # shape, and carry the coverage in alpha. Averaging over all
            # samples instead would darken every antialiased edge.
            i = (y * size + x) * 4
            px[i] = r_sum // hits
            px[i + 1] = g_sum // hits
            px[i + 2] = b_sum // hits
            px[i + 3] = 255 * hits // len(offsets)

    return px


# --------------------------------------------------------------------- main

def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, 'icons')

    if len(sys.argv) == 3:
        size, out = int(sys.argv[1]), sys.argv[2]
        write_png(out, size, size, build(size))
        print(f'wrote {out} ({size}x{size})')
        return

    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f'icon{size}.png')
        write_png(path, size, size, build(size))
        print(f'wrote {path} ({size}x{size})')


if __name__ == '__main__':
    main()
