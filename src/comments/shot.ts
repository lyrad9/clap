// Draw what the user was looking at (frame/image + outline + pin) into a PNG, so Claude can Read it.
import type { Rect } from "../types";

interface ShotOpts {
  source: CanvasImageSource; srcW: number; srcH: number;
  point?: { x: number; y: number };   // normalized
  outline?: Rect;                     // in source pixels
  label?: string;
  maxSide?: number;
}

export async function makeShot({ source, srcW, srcH, point, outline, label, maxSide = 1280 }: ShotOpts): Promise<Blob | null> {
  const k = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.round(srcW * k), h = Math.round(srcH * k);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  try { g.drawImage(source, 0, 0, w, h); } catch { return null; }
  const u = Math.max(2, Math.round(w / 360));
  if (outline) {
    g.strokeStyle = "#ff5a2c"; g.lineWidth = u * 1.5; g.setLineDash([u * 4, u * 2]);
    g.strokeRect(outline[0] * k, outline[1] * k, outline[2] * k, outline[3] * k);
    g.setLineDash([]);
  }
  if (point) {
    const x = point.x * w, y = point.y * h, r = u * 7;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,90,44,0.35)"; g.fill();
    g.lineWidth = u * 1.2; g.strokeStyle = "#ff5a2c"; g.stroke();
    g.beginPath(); g.arc(x, y, u * 1.6, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
  }
  if (label) {
    g.font = `600 ${u * 7}px ui-sans-serif, system-ui`;
    const tw = g.measureText(label).width;
    g.fillStyle = "rgba(0,0,0,0.7)"; g.fillRect(0, 0, tw + u * 8, u * 12);
    g.fillStyle = "#fff"; g.fillText(label, u * 4, u * 8.6);
  }
  return new Promise((ok) => c.toBlob((b) => ok(b), "image/png"));
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = src; });
}
