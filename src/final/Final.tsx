import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Comment, Item, Manifest, Rect, Review, Target, Track } from "../types";
import { durationOf, fileUrl, fmtTime, fpsOf, frameOf, indexItems, isPortrait, targetLabel, timeOfFrame, uid } from "../util";
import { Composer } from "../comments/Composer";
import { CommentList } from "../comments/CommentList";
import { makeShot } from "../comments/shot";
import { uploadShot } from "../api";
import { HtmlLayer } from "./layer";
import { hitTest, targetOf, type Candidate } from "./hit";
import { Timeline } from "./Timeline";
import { Icon } from "../Icon";

interface Selection { target: Target; rect?: Rect | null; cands?: Candidate[]; idx?: number }
interface Draft { target: Target; point?: { x: number; y: number }; rect?: Rect | null }

const RATES = [1, 1.5, 2];
const LAYER_STEP = 5; // seconds: how often the set of loaded layers is revised
const LAYER_AHEAD = 20; // seconds: a timed layer is loaded this long before its start and kept this long after its end
const keyOf = (t?: Target) => (t ? `${t.track}|${t.item ?? ""}|${t.sub ?? ""}` : undefined);

export function Final({ m, review, update }: { m: Manifest; review: Review; update: (fn: (r: Review) => void) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [t, setT] = useState(0);
  const [videoDur, setVideoDur] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [sel, setSel] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [activeComment, setActiveComment] = useState<string>();
  const [layersReady, setLayersReady] = useState(0);

  const fps = fpsOf(m);
  const { w: W, h: H } = m.canvas;
  const portrait = isPortrait(m);
  const duration = durationOf(m, videoDur);
  const idx = useMemo(() => indexItems(m), [m]);
  const tracks = m.tracks || [];
  const comments = review.comments.filter((c) => c.stage === "final");
  const openNow = comments.filter((c) => c.status === "open" && c.round === m.round).length;

  // ---- html layers ------------------------------------------------------------
  // A layer with start/end (one page per graphic, long videos) is loaded only near the playhead and
  // dropped once far away, so a 20-minute video never holds dozens of iframes. Others stay loaded.
  const layers = useRef<HtmlLayer[]>([]);
  const pool = useRef(new Map<number, HtmlLayer>());
  const bucket = Math.floor(t / LAYER_STEP);
  useEffect(() => () => { pool.current.forEach((L) => L.dispose()); pool.current.clear(); layers.current = []; }, [m.layers]);
  useEffect(() => {
    const at = bucket * LAYER_STEP;
    const want = new Set<number>();
    (m.layers || []).forEach((l, i) => {
      if (l.start == null || l.end == null || (at + LAYER_STEP >= l.start - LAYER_AHEAD && at <= l.end + LAYER_AHEAD)) want.add(i);
    });
    for (const [i, L] of pool.current) if (!want.has(i)) { L.dispose(); pool.current.delete(i); }
    for (const i of want) {
      if (pool.current.has(i)) continue;
      const L = new HtmlLayer(m.layers![i]);
      pool.current.set(i, L);
      L.ready.then(() => setLayersReady((n) => n + 1));
    }
    layers.current = [...pool.current.values()];
  }, [m.layers, bucket]);

  // ---- fit the 9:16 or 16:9 frame into the stage -------------------------------
  useLayoutEffect(() => {
    const el = stageRef.current!;
    const fit = () => {
      const cw = el.clientWidth - 16, ch = el.clientHeight - 16;
      const k = Math.min(cw / W, ch / H);
      setBox({ w: Math.max(0, Math.floor(W * k)), h: Math.max(0, Math.floor(H * k)) });
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [W, H]);

  // ---- time: frame-accurate with requestVideoFrameCallback ----------------------
  useEffect(() => {
    const v = video.current!;
    let handle = 0;
    const hasRVFC = "requestVideoFrameCallback" in v;
    const tick = (_now: number, meta?: { mediaTime: number }) => {
      setT(meta ? meta.mediaTime : v.currentTime);
      handle = hasRVFC ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick(0));
    };
    handle = hasRVFC ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick(0));
    const onSeeked = () => setT(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => { setPlaying(false); setT(v.currentTime); };
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      hasRVFC ? v.cancelVideoFrameCallback(handle) : cancelAnimationFrame(handle);
      v.removeEventListener("seeked", onSeeked); v.removeEventListener("play", onPlay); v.removeEventListener("pause", onPause);
    };
  }, []);

  const seek = useCallback((time: number) => {
    const v = video.current!;
    const f = frameOf(Math.max(0, Math.min(duration, time)), fps);
    v.currentTime = timeOfFrame(f, fps);
    setT(v.currentTime);
  }, [duration, fps]);
  const stepFrames = (n: number) => { video.current!.pause(); seek(timeOfFrame(frameOf(t, fps) + n, fps)); };
  const toggle = () => { const v = video.current!; v.paused ? v.play() : v.pause(); };
  const setPlaybackRate = (r: number) => { setRate(r); video.current!.playbackRate = r; };

  // ---- outline of the selection follows the current frame -----------------------
  const outline = useMemo<Rect | null | undefined>(() => {
    if (!sel) return null;
    const { target } = sel;
    const loc = target.sub ? idx.byId.get(target.sub) : target.item ? idx.byId.get(target.item) : undefined;
    const it = loc?.item;
    if (it?.bbox) return (it.start <= t && t < (it.end ?? Infinity)) ? it.bbox : null;
    const rid = it?.rid || target.sub || target.item;
    if (rid && !playing) {
      for (const L of layers.current) {
        if (!L.activeAt(t)) continue;
        L.seek(t);
        const r = L.rectOf(rid);
        if (r) return r;
      }
    }
    return sel.rect ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, t, playing, idx, layersReady]);

  // ---- picking in the frame -----------------------------------------------------
  const toCanvas = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    return { x, y, nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
  };

  const onFrameClick = (e: React.MouseEvent) => {
    video.current!.pause();
    const now = video.current!.currentTime;
    const p = toCanvas(e);
    if (e.altKey && sel?.cands?.length) {
      const i = ((sel.idx ?? 0) + 1) % sel.cands.length;
      const c = sel.cands[i];
      setSel({ ...sel, idx: i, target: c.target, rect: c.rect });
      setDraft((d) => (d ? { ...d, target: c.target, rect: c.rect } : d));
      return;
    }
    const cands = hitTest(m, idx, layers.current, now, p.x, p.y);
    const first = cands[0];
    const target: Target = first?.target || { label: "image" };
    setSel({ target, rect: first?.rect, cands, idx: 0 });
    setDraft({ target, point: { x: p.nx, y: p.ny }, rect: first?.rect });
  };

  const selectItem = (track: Track, item: Item, parent?: Item) => {
    const target = targetOf({ track, item, parent });
    setSel({ target, rect: item.bbox });
    setDraft(null);
    video.current!.pause();
    seek(item.start + 0.001);
  };

  const selectTrack = (track: Track, at: number) => {
    setSel({ target: { track: track.id, label: track.label || track.id } });
    setDraft(null);
    seek(at);
  };

  const selectComment = (c: Comment) => {
    setActiveComment(c.id);
    video.current!.pause();
    if (c.t != null) seek(c.t);
    if (c.range) setRange(c.range);
    setSel({ target: c.target });
    setDraft(null);
  };

  // ---- comments -----------------------------------------------------------------
  async function addComment(text: string) {
    if (!draft) return;
    const v = video.current!;
    const id = uid();
    const now = v.currentTime;
    let shot: string | undefined;
    try {
      const blob = await makeShot({ source: v, srcW: v.videoWidth || W, srcH: v.videoHeight || H, point: draft.point,
        outline: draft.rect ? scaleRect(draft.rect, (v.videoWidth || W) / W) : undefined,
        label: `${fmtTime(now)} · ${targetLabel(draft.target)}` });
      if (blob) shot = await uploadShot(id, blob);
    } catch { /* no shot */ }
    const c: Comment = {
      id, round: m.round, stage: "final", created: new Date().toISOString(),
      target: draft.target, t: Math.round(now * 1000) / 1000, frame: frameOf(now, fps),
      range: range ?? undefined, point: draft.point, shot, text, status: "open", resolution: null,
    };
    update((r) => { r.comments.push(c); if (r.approved_round === m.round) delete r.approved_round; });
    setDraft(null);
    setRange(null);
    setActiveComment(id);
  }

  const commentSelection = () => {
    video.current!.pause();
    setDraft({ target: sel?.target || { label: "general" }, rect: outline ?? undefined });
  };

  // ---- keyboard -------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input")) return;
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key;
      if (k === " " || k === "k" || k === "K") { e.preventDefault(); k === " " ? toggle() : video.current!.pause(); }
      else if (k === "l" || k === "L") { const v = video.current!; if (v.paused) v.play(); else setPlaybackRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]); }
      else if (k === "j" || k === "J") seek(t - 2);
      else if (k === "," || k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? seek(t - 1) : stepFrames(-1); }
      else if (k === "." || k === "ArrowRight") { e.preventDefault(); e.shiftKey ? seek(t + 1) : stepFrames(1); }
      else if (k === "Home") seek(0);
      else if (k === "End") seek(duration);
      else if (k === "c" || k === "C") commentSelection();
      else if (k === "Escape") { if (draft) setDraft(null); else if (range) setRange(null); else setSel(null); }
      else if (k === "[" || k === "]") {
        const list = comments.filter((c) => c.t != null).sort((a, b) => a.t! - b.t!);
        const c = k === "]" ? list.find((x) => x.t! > t + 0.01) : [...list].reverse().find((x) => x.t! < t - 0.01);
        if (c) selectComment(c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const nearby = comments.filter((c) => c.point && c.t != null && (c.range ? t >= c.range[0] && t <= c.range[1] : Math.abs(c.t - t) < 0.5));
  const selLoc = sel?.target.sub ? idx.byId.get(sel.target.sub) : sel?.target.item ? idx.byId.get(sel.target.item) : undefined;

  return (
    <div className={`final ${portrait ? "portrait" : "landscape"}`}>
      <div className="stage" ref={stageRef}>
        <div className="frame" style={{ width: box.w, height: box.h }}>
          <video ref={video} src={fileUrl(m.media!.video!)} preload="auto" playsInline
            onLoadedMetadata={(e) => setVideoDur(e.currentTarget.duration)} />
          <div className="frame-hit" onClick={onFrameClick}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {outline && <rect className="outline" x={outline[0]} y={outline[1]} width={outline[2]} height={outline[3]} />}
            </svg>
            {nearby.map((c) => (
              <span key={c.id} className={`pin ${c.status} ${c.id === activeComment ? "active" : ""}`} title={c.text}
                style={{ left: `${c.point!.x * 100}%`, top: `${c.point!.y * 100}%` }}
                onClick={(e) => { e.stopPropagation(); selectComment(c); }}>{comments.indexOf(c) + 1}</span>
            ))}
            {draft?.point && (
              <>
                <span className="pin draft" style={{ left: `${draft.point.x * 100}%`, top: `${draft.point.y * 100}%` }} />
                <Composer
                  title={`${fmtTime(t)} · ${targetLabel(draft.target)}${range ? ` · range ${fmtTime(range[0])}→${fmtTime(range[1])}` : ""}`}
                  style={{ left: `${Math.min(draft.point.x * 100, portrait ? 30 : 60)}%`, top: `${Math.min(draft.point.y * 100 + 2, portrait ? 72 : 60)}%` }}
                  onSubmit={addComment} onCancel={() => setDraft(null)} />
              </>
            )}
          </div>
        </div>
      </div>

      <aside className="side">
        <div className="transport">
          <button onClick={toggle} className="primary play" aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} /></button>
          <button className="icon-only" onClick={() => stepFrames(-1)} title="previous frame (,)" aria-label="previous frame"><Icon name="prevFrame" /></button>
          <button className="icon-only" onClick={() => stepFrames(1)} title="next frame (.)" aria-label="next frame"><Icon name="nextFrame" /></button>
          <span className="timecode"><span className="mono time">{fmtTime(t)}<span className="of"> / {fmtTime(duration)}</span></span>
            <span className="mono frame-no">f{frameOf(t, fps)}</span></span>
          <div className="seg">
            {[0.5, 1, 1.5, 2].map((r) => <button key={r} className={rate === r ? "on" : ""} onClick={() => setPlaybackRate(r)}>{r}×</button>)}
          </div>
        </div>

        <div className="inspector">
          <div className="insp-head">Inspector</div>
          {!sel && <div className="empty">Click an element in the video or a block in the timeline.</div>}
          {sel && (
            <>
              <div className="insp-target">{targetLabel(sel.target)}</div>
              <div className="kv">
                {sel.target.track && <span>track <b>{sel.target.track}</b></span>}
                {selLoc && <span>{fmtTime(selLoc.item.start)} → {fmtTime(selLoc.item.end)}</span>}
                {selLoc?.item.kind && <span>type <b>{selLoc.item.kind}</b></span>}
                {(selLoc?.item.rid || sel.target.sub) && <span className="mono">{selLoc?.item.rid || sel.target.sub}</span>}
              </div>
              {selLoc?.item.text && <div className="insp-text">“{selLoc.item.text}”</div>}
              {sel.target.source && <div className="src mono">{sel.target.source.file}{sel.target.source.pointer ? ` #${sel.target.source.pointer}` : ""}</div>}
              {selLoc?.item.data !== undefined && (
                <details><summary>data</summary><pre>{JSON.stringify(selLoc.item.data, null, 2)}</pre></details>
              )}
              {sel.cands && sel.cands.length > 1 && (
                <div className="stack">
                  <small>{sel.cands.length} elements under the click (Alt+click for the next one):</small>
                  {sel.cands.map((c, i) => (
                    <button key={i} className={`link ${i === sel.idx ? "on" : ""}`} onClick={() => {
                      setSel({ ...sel, idx: i, target: c.target, rect: c.rect });
                      setDraft((d) => (d ? { ...d, target: c.target, rect: c.rect } : d));
                    }}>{targetLabel(c.target)}</button>
                  ))}
                </div>
              )}
              <div className="actions">
                <button onClick={commentSelection}><Icon name="comment" size={14} />Comment this element <kbd>C</kbd></button>
              </div>
            </>
          )}
          {draft && !draft.point && (
            <Composer style={{ position: "static" }}
              title={`${fmtTime(t)} · ${targetLabel(draft.target)}${range ? ` · range ${fmtTime(range[0])}→${fmtTime(range[1])}` : ""}`}
              onSubmit={addComment} onCancel={() => setDraft(null)} />
          )}
        </div>

        <div className="approve-box">
          {review.approved_round === m.round ? (
            <div className="approved"><span><Icon name="check" size={15} /> Video approved (round {m.round})</span>
              <button className="link" onClick={() => update((r) => { delete r.approved_round; })}>undo</button></div>
          ) : (
            <button className="approve" disabled={openNow > 0} title={openNow ? "Some comments are still open" : ""}
              onClick={() => update((r) => { r.approved_round = m.round; })}>
              <Icon name="check" size={16} />Approve the video (round {m.round})
            </button>
          )}
        </div>

        <CommentList round={m.round} comments={comments} activeId={activeComment} onSelect={selectComment} update={update} />
      </aside>

      <div className="timeline-wrap">
        <Timeline tracks={tracks} chapters={m.chapters} duration={duration} t={t} playing={playing} fps={fps}
          comments={comments} selectedKey={keyOf(sel?.target)} range={range} audioFallback={m.media?.audio || m.media?.video}
          onSeek={(x) => { video.current!.pause(); seek(x); }} onSelectItem={selectItem} onSelectTrack={selectTrack}
          onRange={setRange} onSelectComment={selectComment} />
      </div>
    </div>
  );
}

const scaleRect = (r: Rect, k: number): Rect => [r[0] * k, r[1] * k, r[2] * k, r[3] * k];
