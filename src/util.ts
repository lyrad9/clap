import type { Item, Manifest, Panel, PanelImage, Target, Track } from "./types";

/** Manifest paths are relative to review/; the server exposes the project under /p/. */
export const fileUrl = (rel: string) => new URL(rel, `${location.origin}/p/review/`).pathname;

export const fmtTime = (t?: number) => {
  if (t == null || Number.isNaN(t)) return "–";
  const neg = t < 0; t = Math.abs(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(2).padStart(5, "0");
  return (neg ? "-" : "") + (h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`);
};

export const fpsOf = (m: Manifest) => m.canvas.fps || 30;
export const frameOf = (t: number, fps: number) => Math.floor(t * fps + 1e-4);
/** Seek target for a frame: its middle, so every browser shows that frame. */
export const timeOfFrame = (f: number, fps: number) => (f + 0.5) / fps;

export const uid = (prefix = "c") => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const panelImages = (p: Panel): PanelImage[] => (p.images || []).map((i) => (typeof i === "string" ? { src: i } : i));

export const isPortrait = (m: Manifest) => m.canvas.h > m.canvas.w;

export function durationOf(m: Manifest, videoDuration?: number) {
  if (videoDuration && Number.isFinite(videoDuration)) return videoDuration;
  if (m.duration) return m.duration;
  let d = 0;
  const walk = (items?: Item[]) => items?.forEach((i) => { d = Math.max(d, i.end ?? i.start); walk(i.children); });
  m.tracks?.forEach((t) => walk(t.items));
  m.panels?.forEach((p) => (d = Math.max(d, p.end ?? p.start ?? 0)));
  return d || 1;
}

export interface Located { track: Track; item: Item; parent?: Item }
/** id → item index across all tracks (children included). */
export function indexItems(m: Manifest) {
  const byId = new Map<string, Located>();
  const byRid = new Map<string, Located>();
  for (const track of m.tracks || []) {
    const walk = (items: Item[] | undefined, parent?: Item) => items?.forEach((item) => {
      const loc = { track, item, parent };
      byId.set(item.id, loc);
      if (item.rid) byRid.set(item.rid, loc);
      walk(item.children, item);
    });
    walk(track.items);
  }
  return { byId, byRid };
}

export const targetLabel = (t: Target) => {
  const parts = [t.panel, t.track && !t.item ? t.track : undefined, t.sub || t.item].filter(Boolean);
  return (t.label ? `${t.label} · ` : "") + (parts.join(" › ") || "general");
};

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const trackColor = (t: Track, i: number) =>
  t.color || ["#3d6bff", "#d98200", "#11946a", "#dd3d7c", "#7a5af0", "#1f9bb4", "#9c958a"][i % 7];
