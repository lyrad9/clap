#!/usr/bin/env node
// Clap CLI (also installed as `aisance-video-editing`). Skills call this by name; it never needs to know what a "reel" is.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startServer } from "../server/server.mjs";
import { validateManifest, reconcile, reviewToText } from "../lib/core.mjs";

const USAGE = `clap <command> <projectDir> [options]

Commands
  open <dir>       Start the review app for <dir>/review/manifest.json and open the browser
                   --port N    fixed port (default: random free port)
                   --no-open   do not open the browser
  validate <dir>   Check <dir>/review/manifest.json against the schema (exit 1 on errors)
  status <dir>     Print the gate's review status as JSON: {stage, round, status, open, panels, stages}
  comments <dir>   Print the open comments as text (--all to include resolved ones)

\`aisance-video-editing\` is the same command under its old name.
Contract: README.md in the Clap folder.`;

const [cmd, dir, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

if (!cmd || cmd === "-h" || cmd === "--help" || !dir) {
  console.log(USAGE);
  process.exit(cmd && cmd !== "-h" && cmd !== "--help" ? 2 : 0);
}

const reviewDir = path.join(path.resolve(dir), "review");
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };

function loadOrDie() {
  const m = readJSON(path.join(reviewDir, "manifest.json"));
  if (!m) { console.error(`No manifest at ${path.join(reviewDir, "manifest.json")}`); process.exit(1); }
  const errors = validateManifest(m);
  if (errors.length) { console.error("Invalid manifest:\n  " + errors.join("\n  ")); process.exit(1); }
  const others = ["storyboard", "final"].map((st) => readJSON(path.join(reviewDir, `manifest.${st}.json`)))
    .filter((x) => x && !validateManifest(x).length);
  return { m, r: reconcile(readJSON(path.join(reviewDir, "review.json")), m, others) };
}

switch (cmd) {
  case "validate": {
    const { m } = loadOrDie();
    console.log(`OK — ${m.project}, ${m.stage}, round ${m.round}, ${m.canvas.w}x${m.canvas.h}`);
    break;
  }
  case "status": {
    const { r } = loadOrDie();
    const open = r.comments.filter((c) => c.stage === r.stage && c.status === "open").length;
    console.log(JSON.stringify({ stage: r.stage, round: r.round, status: r.status, open, panels: r.panels, stages: r.stages }, null, 2));
    break;
  }
  case "comments": {
    const { m, r } = loadOrDie();
    console.log(reviewToText(r, m, { onlyOpen: !flag("--all") }));
    break;
  }
  case "open": {
    const srv = await startServer({ projectDir: dir, port: +(opt("--port") || 0) });
    console.log(`clap: ${srv.url}  (project ${srv.root})\nCtrl+C to stop.`);
    if (!flag("--no-open")) spawn(process.platform === "darwin" ? "open" : "xdg-open", [srv.url], { stdio: "ignore", detached: true }).unref();
    const stop = async () => { await srv.close(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(2);
}
