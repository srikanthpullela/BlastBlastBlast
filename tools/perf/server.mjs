// Local test server for the perf/functional checks (no deps).
// Serves the heavy test page on http://localhost:PORT and the same files on
// http://127.0.0.1:PORT, which is a different origin (used for the iframe).
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// Deterministic colourful test image (bands + checker), so blank fragments are obvious.
function makePng(w, h, seed) {
  const stride = w * 3 + 1, raw = Buffer.alloc(stride * h), hue = (seed * 47) % 360;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + 1 + x * 3;
      const band = ((x + y + seed * 13) >> 4) & 1, check = ((x >> 5) ^ (y >> 5)) & 1;
      const [r, g, b] = hsl((hue + (x / w + y / h) * 60) % 360, 0.65, band ? 0.55 : 0.38 + check * 0.1);
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60, x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

export function startServer() {
  const requests = new Map();   // pathname -> count
  const pngCache = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    requests.set(p, (requests.get(p) || 0) + 1);
    const img = p.match(/^\/img\/(\d+)x(\d+)\/(\d+)\/[^/]+\.png$/);
    if (img) {
      const key = img.slice(1, 4).join("/");
      if (!pngCache.has(key)) pngCache.set(key, makePng(+img[1], +img[2], +img[3]));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
      res.end(pngCache.get(key));
      return;
    }
    if (p === "/logo.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#ff6a00"/><text x="20" y="70" font-size="28">SVG</text></svg>');
      return;
    }
    if (p === "/doc.pdf") {
      const body = "BT /F1 24 Tf 50 100 Td (Hello PDF) Tj ET";
      const pdf = "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n" +
        `4 0 obj << /Length ${body.length} >> stream\n${body}\nendstream endobj\n` +
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n";
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(pdf);
      return;
    }
    if (p === "/heavy.html" || p === "/frame.html") {
      const port = server.address().port;
      const html = readFileSync(path.join(DIR, p.slice(1)), "utf8")
        .replaceAll("{{XORIGIN}}", `http://127.0.0.1:${port}`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        origin: `http://localhost:${port}`,
        requests,
        count: (pathname) => requests.get(pathname) || 0,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
