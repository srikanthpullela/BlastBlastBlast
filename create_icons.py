#!/usr/bin/env python3
"""Generate Cannon Blast PNG icons (16/48/128) with no third-party deps.

Uses only the standard library (struct, zlib). Draws a simple stylized
cannon-blast icon: a dark rounded background, a fiery radial-glow circle,
and a black cannon barrel angled up-right with a small muzzle spark.
"""
import struct
import zlib
import math
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")


def lerp(a, b, t):
    return a + (b - a) * t


def blend(dst, src, alpha):
    """Alpha-composite src (r,g,b) over dst (r,g,b) with alpha 0..1."""
    return tuple(int(round(lerp(dst[i], src[i], alpha))) for i in range(3))


def make_icon(size):
    # RGBA framebuffer
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    cx = cy = (size - 1) / 2.0
    R = size / 2.0
    corner = size * 0.22  # rounded-rect corner radius for bg

    def in_rounded_square(x, y):
        # distance into a rounded square covering most of the canvas
        half = size / 2.0 - 0.5
        dx = abs(x - cx) - (half - corner)
        dy = abs(y - cy) - (half - corner)
        dx = max(dx, 0)
        dy = max(dy, 0)
        return math.hypot(dx, dy) <= corner + 0.5

    for y in range(size):
        for x in range(size):
            r, g, b, a = 0, 0, 0, 0

            # 1) Dark rounded background.
            if in_rounded_square(x, y):
                r, g, b, a = 18, 16, 22, 255

            # 2) Fiery radial glow disc.
            d = math.hypot(x - cx, y - cy)
            glow_r = R * 0.82
            if d <= glow_r:
                t = d / glow_r
                if t < 0.35:
                    col = blend((255, 230, 120), (255, 140, 0), t / 0.35)
                elif t < 0.7:
                    col = blend((255, 140, 0), (204, 34, 0), (t - 0.35) / 0.35)
                else:
                    col = blend((204, 34, 0), (60, 10, 0), (t - 0.7) / 0.3)
                # soft edge fade
                edge = max(0.0, min(1.0, (glow_r - d) / (R * 0.12)))
                base = (r, g, b) if a else (18, 16, 22)
                nc = blend(base, col, edge)
                r, g, b = nc
                a = 255

            px[y][x] = (r, g, b, a)

    # 3) Cannon barrel — a thick line from center-left up to the right.
    bx0, by0 = cx - R * 0.28, cy + R * 0.30
    bx1, by1 = cx + R * 0.42, cy - R * 0.38
    barrel_w = max(1.5, size * 0.11)
    draw_thick_line(px, bx0, by0, bx1, by1, barrel_w, (25, 25, 28, 255), size)
    # barrel highlight
    draw_thick_line(px, bx0, by0, bx1, by1, max(1.0, barrel_w * 0.35),
                    (90, 90, 95, 255), size)

    # 4) Cannon wheel/base hub.
    hub_r = size * 0.16
    for y in range(size):
        for x in range(size):
            if math.hypot(x - bx0, y - by0) <= hub_r:
                px[y][x] = (40, 40, 44, 255)
            elif hub_r < math.hypot(x - bx0, y - by0) <= hub_r + max(1, size * 0.03):
                px[y][x] = (15, 15, 18, 255)

    # 5) Muzzle spark at barrel tip.
    spark_r = size * 0.13
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - bx1, y - by1)
            if d <= spark_r:
                t = d / spark_r
                col = blend((255, 255, 230), (255, 120, 0), t)
                edge = max(0.0, min(1.0, (spark_r - d) / (spark_r * 0.6)))
                base = px[y][x][:3]
                nc = blend(base, col, edge)
                px[y][x] = (nc[0], nc[1], nc[2], 255)

    return encode_png(px, size)


def draw_thick_line(px, x0, y0, x1, y1, width, color, size):
    half = width / 2.0
    minx = max(0, int(min(x0, x1) - half - 1))
    maxx = min(size - 1, int(max(x0, x1) + half + 1))
    miny = max(0, int(min(y0, y1) - half - 1))
    maxy = min(size - 1, int(max(y0, y1) + half + 1))
    dx, dy = x1 - x0, y1 - y0
    length2 = dx * dx + dy * dy or 1.0
    for y in range(miny, maxy + 1):
        for x in range(minx, maxx + 1):
            t = ((x - x0) * dx + (y - y0) * dy) / length2
            t = max(0.0, min(1.0, t))
            projx, projy = x0 + t * dx, y0 + t * dy
            if math.hypot(x - projx, y - projy) <= half:
                px[y][x] = color


def encode_png(px, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0
        for x in range(size):
            r, g, b, a = px[y][x]
            raw += bytes((r, g, b, a))

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        crc = zlib.crc32(typ + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        data = make_icon(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(data)
        print(f"wrote {path} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
