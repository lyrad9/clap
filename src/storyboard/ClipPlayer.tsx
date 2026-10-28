// Plays one passage of a preview video (the animatic) in a loop inside a storyboard panel.
// Pause and click to pin a comment at an exact time and point.
import { useEffect, useRef, useState } from "react";
import type { Comment } from "../types";
import { fmtTime, frameOf, timeOfFrame } from "../util";
import { FitBox } from "../FitBox";
import { Icon } from "../Icon";

const PAD = 0.4; // seconds shown before and after the passage

export function ClipPlayer({ src, start, end, w, h, fps, comments, activeId, videoRef, onPick, onSelectComment, children }: {
  src: string; start: number; end: number; w: number; h: number; fps: number;
  comments: Comment[]; activeId?: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onPick: (t: number, point: { x: number; y: number }) => void;
  onSelectComment: (c: Comment) => void;
  children?: React.ReactNode;
}) {
  const [t, setT] = useState(start);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const a = Math.max(0, start - PAD), b = end + PAD;
  const loop = useRef({ a, b });
  loop.current = { a, b };

  useEffect(() => {
    const v = videoRef.current!;
    const reset = () => { v.currentTime = loop.current.a; v.play().catch(() => {}); };
    if (v.readyState >= 1) reset(); else v.addEventListener("loadedmetadata", reset, { once: true });
    let handle = 0;
    const tick = () => {
      if (v.currentTime >= loop.current.b) v.currentTime = loop.current.a;
      setT(v.currentTime);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    const onPlay = () => setPlaying(true), onPause = () => setPlaying(false);
    v.addEventListener("play", onPlay); v.addEventListener("pause", onPause);
    return () => { cancelAnimationFrame(handle); v.removeEventListener("play", onPlay); v.removeEventListener("pause", onPause); };
  }, [src, start, end, videoRef]);

  const toggle = () => { const v = videoRef.current!; v.paused ? v.play() : v.pause(); };
  const step = (n: number) => {
    const v = videoRef.current!; v.pause();
    v.currentTime = Math.min(b, Math.max(a, timeOfFrame(frameOf(v.currentTime, fps) + n, fps)));
  };
  const speed = (r: number) => { setRate(r); videoRef.current!.playbackRate = r; };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input") || e.metaKey || e.ctrlKey) return;
      if (e.key === " ") { e.preventDefault(); toggle(); }
      else if (e.key === ",") step(-1);
      else if (e.key === ".") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const near = comments.filter((c) => c.point && c.t != null && Math.abs(c.t - t) < 0.35);

  return (
    <div className="clip">
      <FitBox w={w} h={h} className="sb-img-wrap clip-frame" onClick={(e) => {
        const v = videoRef.current!; v.pause();
        const r = e.currentTarget.getBoundingClientRect();
        onPick(v.currentTime, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
      }}>
        <video ref={videoRef} src={src} muted={false} playsInline preload="auto" />
        {near.map((c) => (
          <span key={c.id} className={`pin ${c.status} ${c.id === activeId ? "active" : ""}`} title={c.text}
            style={{ left: `${c.point!.x * 100}%`, top: `${c.point!.y * 100}%` }}
            onClick={(e) => { e.stopPropagation(); onSelectComment(c); }}>•</span>
        ))}
        {children}
      </FitBox>
      <div className="clip-bar" onClick={(e) => e.stopPropagation()}>
        <button className="primary small play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} size={14} /></button>
        <button className="small icon-only" onClick={() => step(-1)} title="previous frame (,)" aria-label="previous frame"><Icon name="prevFrame" size={14} /></button>
        <button className="small icon-only" onClick={() => step(1)} title="next frame (.)" aria-label="next frame"><Icon name="nextFrame" size={14} /></button>
        <input type="range" min={a} max={b} step={1 / fps} value={Math.min(b, Math.max(a, t))}
          onChange={(e) => { const v = videoRef.current!; v.pause(); v.currentTime = +e.target.value; }} />
        <span className="mono">{fmtTime(t)}</span>
        <div className="seg">{[0.5, 1, 2].map((r) => <button key={r} className={rate === r ? "on" : ""} onClick={() => speed(r)}>{r}×</button>)}</div>
      </div>
    </div>
  );
}
