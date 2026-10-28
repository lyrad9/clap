// Zoomable multi-track timeline. Only items inside the visible window are rendered, so a long
// 16:9 video with thousands of caption words stays fluid.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Chapter, Comment, Item, Track } from "../types";
import { clamp, fmtTime, trackColor } from "../util";
import { fetchPeaks } from "../api";
import { Icon } from "../Icon";

const LABEL_W = 150;
const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

export interface TimelineProps {
  tracks: Track[]; chapters?: Chapter[]; duration: number; t: number; playing: boolean; fps: number;
  comments: Comment[]; selectedKey?: string; range: [number, number] | null;
  audioFallback?: string;
  onSeek: (t: number) => void;
  onSelectItem: (track: Track, item: Item, parent?: Item) => void;
  onSelectTrack: (track: Track, t: number) => void;
  onRange: (r: [number, number] | null) => void;
  onSelectComment: (c: Comment) => void;
}

export function Timeline(p: TimelineProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [pps, setPps] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const laneW = Math.max(1, width - LABEL_W);
  const fitPps = laneW / Math.max(1, p.duration);
  const scale = pps ?? fitPps;
  const total = p.duration * scale;

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // keep the playhead in view: while playing, and after any jump (comment, frame click, keyboard).
  // Scrolling by hand while paused does not change t, so it is never fought.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const x = p.t * scale;
    if (x < el.scrollLeft || x > el.scrollLeft + laneW - 40) el.scrollLeft = Math.max(0, x - laneW * (p.playing ? 0.15 : 0.4));
  }, [p.t, p.playing, scale, laneW]);

  // zoom around the cursor with ctrl/cmd + wheel (pinch on a trackpad)
  useEffect(() => {
    const el = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - LABEL_W + el.scrollLeft;
      const tAt = x / scale;
      const next = clamp(scale * Math.exp(-e.deltaY * 0.01), fitPps, 2000);
      setPps(next);
      requestAnimationFrame(() => { el.scrollLeft = tAt * next - (e.clientX - rect.left - LABEL_W); });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, fitPps]);

  const zoomBy = (k: number) => {
    const el = scroller.current!;
    const next = clamp(scale * k, fitPps, 2000);
    setPps(next);
    requestAnimationFrame(() => { el.scrollLeft = p.t * next - laneW / 2; });
  };

  const view = useMemo(() => {
    const margin = 200 / scale;
    // bucket the window so rows only re-render when the view moves noticeably
    const q = 100 / scale;
    const a = Math.floor((scrollLeft / scale - margin) / q) * q;
    const b = Math.ceil(((scrollLeft + laneW) / scale + margin) / q) * q;
    return [a, b] as [number, number];
  }, [scrollLeft, scale, laneW]);

  const xToT = (clientX: number) => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left - LABEL_W + el.scrollLeft;
    return clamp(x / scale, 0, p.duration);
  };

  // ruler: click seeks, drag selects a range for the next comment
  const onRulerDown = (e: React.MouseEvent) => {
    const t0 = xToT(e.clientX);
    let moved = false;
    p.onSeek(t0);
    const move = (ev: MouseEvent) => {
      const t1 = xToT(ev.clientX);
      if (Math.abs(t1 - t0) * scale > 4) moved = true;
      if (moved) p.onRange([Math.min(t0, t1), Math.max(t0, t1)]);
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      if (!moved) p.onRange(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const step = TICKS.find((s) => s * scale >= 70) ?? 3600;
  const ticks: number[] = [];
  for (let s = Math.max(0, Math.floor(view[0] / step) * step); s <= Math.min(p.duration, view[1]); s += step) ticks.push(s);

  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="tl">
      <div className="tl-toolbar">
        <button className="small" onClick={() => zoomBy(1 / 1.6)}>−</button>
        <button className="small" onClick={() => zoomBy(1.6)}>+</button>
        <button className="small" onClick={() => setPps(null)}>Fit</button>
        <span className="muted hint">⌘/Ctrl + wheel to zoom · drag on the ruler = range</span>
        {p.range && (
          <span className="range-chip">range {fmtTime(p.range[0])} → {fmtTime(p.range[1])}
            <button className="link" onClick={() => p.onRange(null)} aria-label="Clear the range"><Icon name="close" size={12} /></button></span>
        )}
      </div>
      <div className="tl-scroll" ref={scroller} onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}>
        <div className="tl-inner" style={{ width: LABEL_W + total }}>
          <div className="tl-row ruler">
            <div className="tl-label">{fmtTime(p.t)} <small>f{Math.floor(p.t * p.fps + 1e-4)}</small></div>
            <div className="tl-lane" style={{ width: total }} onMouseDown={onRulerDown}>
              {p.chapters?.filter((c) => c.end >= view[0] && c.start <= view[1]).map((c) => (
                <div key={c.id} className="chapter" style={{ left: c.start * scale, width: (c.end - c.start) * scale }} title={c.title}>{c.title}</div>
              ))}
              {ticks.map((s) => (
                <div key={s} className="tick" style={{ left: s * scale }}><span>{fmtTime(s).replace(/\.00$/, "")}</span></div>
              ))}
              {p.range && <div className="range" style={{ left: p.range[0] * scale, width: (p.range[1] - p.range[0]) * scale }} />}
            </div>
          </div>

          <div className="tl-row comments-row">
            <div className="tl-label">Comments</div>
            <div className="tl-lane" style={{ width: total }}>
              {p.comments.filter((c) => c.t != null && c.t >= view[0] && c.t <= view[1]).map((c) => (
                <div key={c.id} className={`cmark ${c.status}`} title={c.text}
                  style={{ left: c.t! * scale, width: c.range ? Math.max(8, (c.range[1] - c.range[0]) * scale) : undefined }}
                  onMouseDown={(e) => { e.stopPropagation(); p.onSelectComment(c); }} />
              ))}
            </div>
          </div>

          {p.tracks.map((track, ti) => (
            <TrackRows key={track.id} track={track} color={trackColor(track, ti)} scale={scale} total={total} view={view}
              expanded={expanded.has(track.id)} onToggle={() => toggle(track.id)} selectedKey={p.selectedKey}
              audioFallback={p.audioFallback} scrollLeft={scrollLeft} laneW={laneW}
              onSelectItem={p.onSelectItem} onSelectTrack={(tr, e) => p.onSelectTrack(tr, xToT(e.clientX))} />
          ))}

          <div className="playhead" style={{ left: LABEL_W + p.t * scale }} />
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  track: Track; color: string; scale: number; total: number; view: [number, number]; expanded: boolean; selectedKey?: string;
  audioFallback?: string; scrollLeft: number; laneW: number;
  onToggle: () => void;
  onSelectItem: (track: Track, item: Item, parent?: Item) => void;
  onSelectTrack: (track: Track, e: React.MouseEvent) => void;
}

/** Greedy lane packing so overlapping items stay readable. */
function lanes(items: { item: Item; parent?: Item }[]) {
  const ends: number[] = [];
  return items.map((x) => {
    const s = x.item.start, e = x.item.end ?? s + 0.001;
    let lane = ends.findIndex((end) => end <= s);
    if (lane < 0) { lane = ends.length; ends.push(e); } else ends[lane] = e;
    return { ...x, lane };
  });
}

const TrackRows = memo(function TrackRows(r: RowProps) {
  const { track, scale, view } = r;
  const items = track.items || [];
  const vis = (it: Item) => (it.end ?? it.start) >= view[0] && it.start <= view[1];
  const hasChildren = items.some((i) => i.children?.length);
  const parentRows = useMemo(() => lanes([...items].sort((a, b) => a.start - b.start).map((item) => ({ item }))), [items]);
  const childRows = useMemo(() => lanes(
    items.flatMap((parent) => (parent.children || []).map((item) => ({ item, parent }))).sort((a, b) => a.item.start - b.item.start),
  ), [items]);
  const nLanes = Math.max(1, ...parentRows.map((x) => x.lane + 1));
  const nChildLanes = Math.max(1, ...childRows.map((x) => x.lane + 1));
  const point = track.kind === "marker" || track.kind === "audio-cue";
  const rowH = track.kind === "word" ? 22 : 26;

  const block = (x: { item: Item; parent?: Item; lane: number }) => {
    const it = x.item;
    const left = it.start * scale;
    const key = `${track.id}|${x.parent ? x.parent.id : it.id}|${x.parent ? it.id : ""}`;
    const sel = r.selectedKey === key || r.selectedKey === `${track.id}|${it.id}|`;
    const text = it.label || it.text || it.id;
    if (point || it.end == null || it.end <= it.start) {
      return (
        <div key={it.id} className={`diamond ${sel ? "sel" : ""}`} title={`${text} · ${fmtTime(it.start)}`}
          style={{ left, top: x.lane * rowH + rowH / 2, background: r.color }}
          onMouseDown={(e) => { e.stopPropagation(); r.onSelectItem(track, it, x.parent); }} />
      );
    }
    const w = Math.max(2, (it.end - it.start) * scale);
    return (
      <div key={it.id} className={`block ${track.kind} ${sel ? "sel" : ""}`} title={`${text} · ${fmtTime(it.start)} → ${fmtTime(it.end)}`}
        style={{ left, width: w, top: x.lane * rowH + 2, height: rowH - 4, borderColor: r.color, background: `${r.color}33` }}
        onMouseDown={(e) => { e.stopPropagation(); r.onSelectItem(track, it, x.parent); }}>
        {w > 26 && <span>{text}</span>}
      </div>
    );
  };

  return (
    <>
      <div className="tl-row">
        <div className="tl-label" title={track.id}>
          {hasChildren && <button className="twisty" onClick={r.onToggle}>{r.expanded ? "▾" : "▸"}</button>}
          <span className="swatch" style={{ background: r.color }} />{track.label || track.id}
        </div>
        <div className="tl-lane" style={{ width: r.total, height: track.kind === "audio" ? 44 : nLanes * rowH }}
          onMouseDown={(e) => r.onSelectTrack(track, e)}>
          {track.kind === "audio"
            ? <Waveform src={track.src || r.audioFallback} color={r.color} scale={scale} scrollLeft={r.scrollLeft} width={r.laneW} />
            : parentRows.filter((x) => vis(x.item)).map(block)}
        </div>
      </div>
      {hasChildren && r.expanded && (
        <div className="tl-row child">
          <div className="tl-label">↳ elements</div>
          <div className="tl-lane" style={{ width: r.total, height: nChildLanes * 22 }}>
            {childRows.filter((x) => vis(x.item)).map((x) => block(x))}
          </div>
        </div>
      )}
    </>
  );
});

function Waveform({ src, color, scale, scrollLeft, width }: { src?: string; color: string; scale: number; scrollLeft: number; width: number }) {
  const [data, setData] = useState<{ perSecond: number; peaks: number[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!src) return;
    fetchPeaks(src, 100).then((d) => (d ? setData(d) : setFailed(true))).catch(() => setFailed(true));
  }, [src]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr; c.height = 44 * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, 44);
    g.fillStyle = color;
    const n = data.peaks.length / 2;
    for (let x = 0; x < width; x++) {
      const t0 = (scrollLeft + x) / scale, t1 = (scrollLeft + x + 1) / scale;
      const a = Math.floor(t0 * data.perSecond), b = Math.max(a + 1, Math.ceil(t1 * data.perSecond));
      let lo = 0, hi = 0;
      for (let i = a; i < b && i < n; i++) { lo = Math.min(lo, data.peaks[2 * i]); hi = Math.max(hi, data.peaks[2 * i + 1]); }
      const y0 = 22 - hi * 20, y1 = 22 - lo * 20;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [data, scale, scrollLeft, width, color]);
  if (!src) return <span className="muted pad">no audio source</span>;
  if (failed) return <span className="muted pad">waveform unavailable</span>;
  return <canvas ref={ref} className="wave" style={{ left: scrollLeft, width, height: 44 }} />;
}
