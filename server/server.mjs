// Clap's local server: serves the UI, the project folder (read-only, Range for video),
// review.json (atomic writes), shot uploads, audio peaks and a change feed (SSE).
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateManifest, validateReview, reconcile, restatus, computePeaks } from "../lib/core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../dist");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain; charset=utf-8",
};

export async function startServer({ projectDir, port = 0, host = "127.0.0.1" }) {
  const root = await fsp.realpath(path.resolve(projectDir));
  const reviewDir = path.join(root, "review");
  const manifestPath = path.join(reviewDir, "manifest.json");
  const reviewPath = path.join(reviewDir, "review.json");

  const inside = (p) => p === root || p.startsWith(root + path.sep);

  /** Media the manifest names explicitly; only these may be symlinks pointing outside the project. */
  async function manifestMedia() {
    const out = new Set();
    const add = (rel) => rel && out.add(path.resolve(reviewDir, rel));
    for (const f of ["manifest.json", ...STAGES.map((st) => `manifest.${st}.json`)]) {
      const m = await readJSON(path.join(reviewDir, f)).catch(() => null);
      if (!m) continue;
      add(m.media?.video); add(m.media?.audio);
      for (const t of m.tracks || []) add(t.src);
    }
    return out;
  }

  /**
   * Resolve a project-relative path, refusing anything that escapes the project: the path itself must stay
   * inside, and so must its real target, unless it is a media file the manifest references (a music track
   * symlinked from another folder, say).
   */
  async function safe(rel) {
    const abs = path.resolve(root, rel);
    if (!inside(abs)) return null;
    let real;
    try { real = await fsp.realpath(abs); } catch { return null; }
    if (inside(real)) return real;
    return (await manifestMedia()).has(abs) ? real : null;
  }

  async function readJSON(p) {
    try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  async function writeAtomic(p, text) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, p);
  }

  const STAGES = ["storyboard", "final"];

  /**
   * The gate (review/manifest.json: the stage the skill is waiting on) plus one manifest per stage
   * (review/manifest.<stage>.json) so the user can switch between storyboard and final review.
   */
  async function loadManifests() {
    const gate = await readJSON(manifestPath);
    if (!gate) return { gate: null, byStage: {}, errors: [`No manifest at ${path.relative(root, manifestPath)}`] };
    const errors = validateManifest(gate);
    const byStage = {};
    for (const st of STAGES) {
      const m = await readJSON(path.join(reviewDir, `manifest.${st}.json`)).catch(() => null);
      if (m && m.stage === st && !validateManifest(m).length) byStage[st] = m;
    }
    if (!errors.length) byStage[gate.stage] = gate;
    return { gate, byStage, errors };
  }

  async function loadReview(gate, byStage) {
    const saved = await readJSON(reviewPath);
    const r = reconcile(saved, gate, Object.values(byStage));
    const st = await fsp.stat(reviewPath).catch(() => null);
    return { review: r, version: st ? String(st.mtimeMs) : "0" };
  }

  // ---- change feed -------------------------------------------------------
  const clients = new Set();
  let lastSelfWrite = 0;
  const pending = new Map();
  const notify = (kind) => {
    clearTimeout(pending.get(kind));
    pending.set(kind, setTimeout(() => {
      const self = Date.now() - lastSelfWrite < 400;
      for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify({ kind, self })}\n\n`);
    }, 150));
  };
  await fsp.mkdir(reviewDir, { recursive: true });
  const watcher = fs.watch(reviewDir, (_ev, name) => {
    if (/^manifest(\.\w+)?\.json$/.test(name || "")) notify("manifest");
    else if (name === "review.json") notify("review");
  });
  const heartbeat = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000);

  // ---- helpers -------------------------------------------------------------
  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const body = (req, limit = 50e6) => new Promise((ok, ko) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { ko(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", ko);
  });

  async function serveFile(req, res, abs, { cache = false } = {}) {
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return send(res, 404, { error: "not found" });
    const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
    const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": cache ? "max-age=3600" : "no-cache",
                      "last-modified": st.mtime.toUTCString() };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] ? +range[1] : st.size - +range[2];
      let end = range[1] && range[2] ? +range[2] : st.size - 1;
      if (!range[1]) end = st.size - 1;
      if (start >= st.size || start < 0 || end < start) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "content-length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(abs).pipe(res);
  }

  /** Decode audio to mono 8 kHz with ffmpeg, bucket into peaks, cache by file identity. */
  async function peaks(abs, perSecond) {
    const st = await fsp.stat(abs);
    const key = crypto.createHash("sha1").update(`${abs}|${st.size}|${st.mtimeMs}|${perSecond}`).digest("hex").slice(0, 16);
    const cachePath = path.join(reviewDir, ".cache", `peaks-${key}.json`);
    const cached = await readJSON(cachePath);
    if (cached) return cached;
    const rate = 8000;
    const pcm = await new Promise((ok, ko) => {
      const ff = spawn("ffmpeg", ["-v", "error", "-i", abs, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"]);
      const chunks = [];
      ff.stdout.on("data", (c) => chunks.push(c));
      ff.on("error", ko);
      ff.on("close", (code) => (code === 0 ? ok(Buffer.concat(chunks)) : ko(new Error(`ffmpeg exited ${code}`))));
    });
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    const duration = samples.length / rate;
    const data = { duration, perSecond, peaks: computePeaks(samples, Math.ceil(duration * perSecond)) };
    await writeAtomic(cachePath, JSON.stringify(data));
    return data;
  }

  // ---- routes --------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const p = decodeURIComponent(url.pathname);

      if (p === "/api/state" && req.method === "GET") {
        const { gate, byStage, errors } = await loadManifests();
        if (!gate || errors.length) return send(res, 200, { manifest: gate, errors, review: null, root });
        const want = url.searchParams.get("stage");
        const manifest = byStage[want] || gate;
        const { review, version } = await loadReview(gate, byStage);
        return send(res, 200, { manifest, gateStage: gate.stage, stages: STAGES.filter((s) => byStage[s]), errors, review, version, root });
      }

      if (p === "/api/review" && req.method === "PUT") {
        const { gate, byStage, errors } = await loadManifests();
        if (!gate || errors.length) return send(res, 409, { error: "manifest invalid", errors });
        const { version } = await loadReview(gate, byStage);
        const ifMatch = req.headers["if-match"];
        if (ifMatch && ifMatch !== version) return send(res, 409, { error: "review.json changed on disk", version });
        const r = restatus(JSON.parse((await body(req)).toString("utf8")), gate, Object.values(byStage));
        r.updated = new Date().toISOString();
        const errs = validateReview(r);
        if (errs.length) return send(res, 400, { error: "invalid review", errors: errs });
        lastSelfWrite = Date.now();
        await writeAtomic(reviewPath, JSON.stringify(r, null, 2) + "\n");
        const st = await fsp.stat(reviewPath);
        return send(res, 200, { review: r, version: String(st.mtimeMs) });
      }

      const shot = /^\/api\/shot\/([A-Za-z0-9_-]+)$/.exec(p);
      if (shot && req.method === "POST") {
        const png = await body(req, 20e6);
        if (png.subarray(1, 4).toString() !== "PNG") return send(res, 400, { error: "expected PNG" });
        const rel = `shots/${shot[1]}.png`;
        await writeAtomic(path.join(reviewDir, rel), png);
        return send(res, 200, { shot: rel });
      }

      if (p === "/api/peaks" && req.method === "GET") {
        const abs = await safe(path.join("review", url.searchParams.get("src") || ""));
        if (!abs) return send(res, 404, { error: "not found" });
        const per = Math.min(200, Math.max(5, +(url.searchParams.get("per") || 50)));
        return send(res, 200, await peaks(abs, per));
      }

      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      if (p.startsWith("/p/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read only" });
        const abs = await safe(p.slice(3));
        if (!abs) return send(res, 404, { error: "not found" });
        return serveFile(req, res, abs);
      }

      // UI (built by vite)
      const rel = p === "/" ? "index.html" : p.slice(1);
      const abs = path.resolve(DIST, rel);
      if (abs.startsWith(DIST + path.sep) && fs.existsSync(abs)) return serveFile(req, res, abs, { cache: rel.startsWith("assets/") });
      if (fs.existsSync(path.join(DIST, "index.html"))) return serveFile(req, res, path.join(DIST, "index.html"));
      return send(res, 500, "UI not built: run `npm run build` in the Clap folder.", "text/plain");
    } catch (e) {
      send(res, 500, { error: String(e?.message || e) });
    }
  });

  await new Promise((ok) => server.listen(port, host, ok));
  const addr = server.address();
  return {
    url: `http://${host}:${addr.port}/`,
    root,
    close: () => { watcher.close(); clearInterval(heartbeat); for (const c of clients) c.end(); return new Promise((ok) => server.close(ok)); },
  };
}
