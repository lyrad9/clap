import { useEffect, useMemo, useRef, useState } from "react";
import type { Comment, Manifest, Panel, PanelState, Review } from "../types";
import { fileUrl, fmtTime, fpsOf, frameOf, isPortrait, panelImages, uid } from "../util";
import { Composer } from "../comments/Composer";
import { CommentList } from "../comments/CommentList";
import { loadImage, makeShot } from "../comments/shot";
import { uploadShot } from "../api";
import { FitBox } from "../FitBox";
import { ClipPlayer } from "./ClipPlayer";
import { Icon } from "../Icon";

type Draft = { image?: number; point?: { x: number; y: number }; clipT?: number } | null;

const STATE_LABEL: Record<PanelState, string> = { pending: "to review", approved: "approved", changes: "needs changes" };

export function Storyboard({ m, review, update }: { m: Manifest; review: Review; update: (fn: (r: Review) => void) => void }) {
  const panels = m.panels || [];
  const [sel, setSel] = useState(() => Math.max(0, panels.findIndex((p) => review.panels[p.id] !== "approved")));
  const [grid, setGrid] = useState(false);
  const [draft, setDraft] = useState<Draft>(null);
  const [activeComment, setActiveComment] = useState<string>();
  const panel = panels[Math.min(sel, panels.length - 1)];
  const comments = review.comments.filter((c) => c.stage === "storyboard");
  const panelComments = comments.filter((c) => c.target.panel === panel?.id);
  const approved = panels.filter((p) => review.panels[p.id] === "approved").length;
  const stripRef = useRef<HTMLDivElement>(null);
  const clipVideo = useRef<HTMLVideoElement>(null);
  const clipSrc = panel?.clip ? fileUrl(panel.clip.src || m.media?.video || "") : null;
  const [view, setView] = useState<"clip" | "stills">("clip");
  const showClip = !!clipSrc && view === "clip";

  const setState = (p: Panel, s: PanelState) => update((r) => { r.panels[p.id] = s; });
  const go = (i: number) => { setSel(Math.max(0, Math.min(panels.length - 1, i))); setDraft(null); };
  const approve = () => {
    if (!panel) return;
    const open = panelComments.filter((c) => c.status === "open").length;
    if (open && !confirm(`${open} open comment(s) on this panel. Approve anyway?`)) return;
    setState(panel, "approved");
    const next = panels.findIndex((p, i) => i > sel && review.panels[p.id] !== "approved");
    if (next >= 0) go(next);
  };

  async function addComment(text: string) {
    if (!panel || !draft) return;
    const id = uid();
    const imgs = panelImages(panel);
    let shot: string | undefined;
    const v = clipVideo.current;
    if (draft.clipT != null && v) {
      try {
        const blob = await makeShot({ source: v, srcW: v.videoWidth || m.canvas.w, srcH: v.videoHeight || m.canvas.h,
          point: draft.point, label: `${panel.id} · ${fmtTime(draft.clipT)}` });
        if (blob) shot = await uploadShot(id, blob);
      } catch { /* no shot */ }
    } else if (draft.image != null && imgs[draft.image]) {
      try {
        const img = await loadImage(fileUrl(imgs[draft.image].src));
        const blob = await makeShot({ source: img, srcW: img.naturalWidth, srcH: img.naturalHeight, point: draft.point,
          label: `${panel.id} · image ${draft.image + 1}` });
        if (blob) shot = await uploadShot(id, blob);
      } catch { /* the comment still works without a shot */ }
    }
    const c: Comment = {
      id, round: m.round, stage: "storyboard", created: new Date().toISOString(),
      target: { panel: panel.id, image: draft.image, label: panel.title, source: panel.source },
      t: draft.clipT != null ? Math.round(draft.clipT * 1000) / 1000
        : draft.image != null ? imgs[draft.image]?.t ?? panel.start : panel.start,
      frame: draft.clipT != null ? frameOf(draft.clipT, fpsOf(m)) : undefined,
      point: draft.point, shot, text, status: "open", resolution: null,
    };
    update((r) => { r.comments.push(c); if (r.panels[panel.id] !== "changes") r.panels[panel.id] = "changes"; });
    setDraft(null);
    setActiveComment(id);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "arrowright" || k === "arrowdown") { e.preventDefault(); go(sel + 1); }
      else if (k === "arrowleft" || k === "arrowup") { e.preventDefault(); go(sel - 1); }
      else if (k === "a") approve();
      else if (k === "x" && panel) setState(panel, "changes");
      else if (k === "c") setDraft(showClip && clipVideo.current ? { clipT: clipVideo.current.currentTime } : {});
      else if (k === "v" && clipSrc) setView((x) => (x === "clip" ? "stills" : "clip"));
      else if (k === "g") setGrid((g) => !g);
      else if (k === "escape") setDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    stripRef.current?.querySelector(".strip-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const groups = useMemo(() => {
    const out: { title?: string; items: { p: Panel; i: number }[] }[] = [];
    panels.forEach((p, i) => {
      const ch = m.chapters?.find((c) => c.id === p.chapter);
      const title = ch?.title;
      if (!out.length || out[out.length - 1].title !== title) out.push({ title, items: [] });
      out[out.length - 1].items.push({ p, i });
    });
    return out;
  }, [panels, m.chapters]);

  if (!panel) return <div className="empty big">No panels in the manifest.</div>;
  const portrait = isPortrait(m);
  const imgs = panelImages(panel);

  if (grid) {
    return (
      <div className="sb-grid-wrap">
        <div className="sb-toolbar">
          <span>{approved}/{panels.length} approved</span>
          <button onClick={() => setGrid(false)}>Detail view <kbd>G</kbd></button>
        </div>
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.title && (
              <div className="sb-grid-chapter">{g.title}
                <small>{g.items.filter(({ p }) => review.panels[p.id] === "approved").length}/{g.items.length} approved</small>
              </div>
            )}
            <div className={`sb-grid ${portrait ? "portrait" : "landscape"}`}>
              {g.items.map(({ p, i }) => {
                const st = review.panels[p.id] || "pending";
                const n = comments.filter((c) => c.target.panel === p.id && c.status === "open").length;
                const first = panelImages(p)[panelImages(p).length - 1];
                return (
                  <button key={p.id} className={`sb-card ${st}`} onClick={() => { setSel(i); setGrid(false); }}>
                    <div className="sb-card-img" style={{ aspectRatio: `${m.canvas.w}/${m.canvas.h}` }}>
                      {first && <img src={fileUrl(first.src)} loading="lazy" alt="" />}
                    </div>
                    <div className="sb-card-meta">
                      <b>{i + 1}. {p.title}</b>
                      <span className={`pill ${st}`}>{STATE_LABEL[st]}</span>{n > 0 && <span className="count" title={`${n} open comment${n > 1 ? "s" : ""}`}><Icon name="comment" size={12} />{n}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`sb ${portrait ? "portrait" : "landscape"}`}>
      <aside className="strip" ref={stripRef}>
        <div className="strip-head">{approved}/{panels.length} approved
          <div className="progress"><div style={{ transform: `scaleX(${approved / panels.length})` }} /></div>
          <button className="ghost small" onClick={() => setGrid(true)}><Icon name="grid" size={13} />Grid <kbd>G</kbd></button>
        </div>
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.title && <div className="strip-chapter">{g.title}</div>}
            {g.items.map(({ p, i }) => {
              const st = review.panels[p.id] || "pending";
              const thumb = panelImages(p)[panelImages(p).length - 1];
              const n = comments.filter((c) => c.target.panel === p.id && c.status === "open").length;
              return (
                <button key={p.id} className={`strip-item ${i === sel ? "sel" : ""} ${st} ${p.kind === "window" ? "window" : ""}`} onClick={() => go(i)}>
                  <span className={`dot ${st}`} />
                  {thumb && <img src={fileUrl(thumb.src)} loading="lazy" alt="" style={{ aspectRatio: `${m.canvas.w}/${m.canvas.h}` }} />}
                  <span className="strip-label"><span className="strip-title"><b>{i + 1}</b> {p.title}</span><small>{fmtTime(p.start)}{n > 0 && <span className="count"><Icon name="comment" size={11} />{n}</span>}</small></span>
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <main className="sb-stage">
        {clipSrc && (
          <div className="seg view-switch">
            <button className={view === "clip" ? "on" : ""} onClick={() => setView("clip")}><Icon name="film" size={13} />Animation</button>
            <button className={view === "stills" ? "on" : ""} onClick={() => setView("stills")}>Stills</button>
          </div>
        )}
        {showClip && panel.clip && (
          <ClipPlayer key={panel.id} src={clipSrc!} start={panel.clip.start} end={panel.clip.end} w={m.canvas.w} h={m.canvas.h}
            fps={fpsOf(m)} comments={panelComments.filter((c) => c.target.image == null)} activeId={activeComment} videoRef={clipVideo}
            onPick={(t, point) => setDraft({ clipT: t, point })} onSelectComment={(c) => {
              setActiveComment(c.id);
              if (clipVideo.current && c.t != null) { clipVideo.current.pause(); clipVideo.current.currentTime = c.t; }
            }}>
            {draft?.clipT != null && draft.point && (
              <>
                <span className="pin draft" style={{ left: `${draft.point.x * 100}%`, top: `${draft.point.y * 100}%` }} />
                <Composer title={`${panel.title} · ${fmtTime(draft.clipT)}`}
                  style={{ left: `${Math.min(draft.point.x * 100, portrait ? 25 : 60)}%`, top: `${Math.min(draft.point.y * 100 + 2, 70)}%` }}
                  onSubmit={addComment} onCancel={() => setDraft(null)} />
              </>
            )}
          </ClipPlayer>
        )}
        {!showClip && <div className={`sb-images n${imgs.length}`}>
          {!imgs.length && <div className="empty big">No image for this panel.</div>}
          {imgs.map((im, ii) => (
            <figure key={im.src + ii} className="sb-figure">
              <FitBox
                w={m.canvas.w} h={m.canvas.h} className="sb-img-wrap"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setDraft({ image: ii, point: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } });
                }}
              >
                <img src={fileUrl(im.src)} alt="" draggable={false} />
                {panelComments.filter((c) => c.target.image === ii && c.point).map((c) => (
                  <Pin key={c.id} c={c} n={comments.indexOf(c) + 1} active={c.id === activeComment} onClick={() => setActiveComment(c.id)} />
                ))}
                {draft?.image === ii && draft.point && (
                  <>
                    <span className="pin draft" style={{ left: `${draft.point.x * 100}%`, top: `${draft.point.y * 100}%` }} />
                    <Composer
                      title={`${panel.title} · image ${ii + 1}`}
                      style={{ left: `${Math.min(draft.point.x * 100, 55)}%`, top: `${Math.min(draft.point.y * 100 + 2, 70)}%` }}
                      onSubmit={addComment} onCancel={() => setDraft(null)}
                    />
                  </>
                )}
              </FitBox>
              <figcaption>{im.label || `Image ${ii + 1}`}{im.t != null ? ` · ${fmtTime(im.t)}` : ""}</figcaption>
            </figure>
          ))}
        </div>}
        <div className="sb-nav">
          <button onClick={() => go(sel - 1)} disabled={sel === 0}>← Previous</button>
          <span className="mono">{sel + 1} / {panels.length}</span>
          <button onClick={() => go(sel + 1)} disabled={sel === panels.length - 1}>Next →</button>
        </div>
      </main>

      <aside className="side">
        <div className="panel-info">
          <div className="panel-title">
            <h2>{sel + 1}. {panel.title}</h2>
            <span className={`pill ${review.panels[panel.id] || "pending"}`}>{STATE_LABEL[review.panels[panel.id] || "pending"]}</span>
          </div>
          <div className="kv">
            {panel.kind && <span>type <b>{panel.kind}</b></span>}
            {panel.start != null && <span>{fmtTime(panel.start)} → {fmtTime(panel.end)}</span>}
            <span className="mono">{panel.id}</span>
          </div>
          {panel.description && <p className="desc">{panel.description}</p>}
          {panel.excerpt && <blockquote>{panel.excerpt}</blockquote>}
          {panel.source && <div className="src mono">{panel.source.file}{panel.source.pointer ? ` #${panel.source.pointer}` : ""}</div>}
          <div className="actions">
            <button className="approve" onClick={approve}><Icon name="check" size={14} />Approve <kbd>A</kbd></button>
            <button className="changes" onClick={() => setState(panel, "changes")}><Icon name="pencil" size={14} />Needs changes <kbd>X</kbd></button>
            <button onClick={() => setDraft({})}><Icon name="comment" size={14} />General comment <kbd>C</kbd></button>
          </div>
          {draft && draft.image == null && draft.point == null && (
            <Composer title={`${panel.title} · general`} onSubmit={addComment} onCancel={() => setDraft(null)} style={{ position: "static" }} />
          )}
        </div>
        <CommentList round={m.round} comments={panelComments} activeId={activeComment} update={update}
          onSelect={(c) => setActiveComment(c.id)} />
      </aside>
    </div>
  );
}

function Pin({ c, n, active, onClick }: { c: Comment; n: number; active: boolean; onClick: () => void }) {
  return (
    <span
      className={`pin ${c.status} ${active ? "active" : ""}`} title={c.text}
      style={{ left: `${c.point!.x * 100}%`, top: `${c.point!.y * 100}%` }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >{n}</span>
  );
}
