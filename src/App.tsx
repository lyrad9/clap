import { useEffect, useState } from "react";
import type { Stage } from "./types";
import { useStore } from "./api";
import { Storyboard } from "./storyboard/Storyboard";
import { Final } from "./final/Final";
import { reviewToText } from "./text";
import { Icon } from "./Icon";

const STATUS: Record<string, string> = { in_review: "in review", changes_requested: "changes requested", approved: "approved" };

export function App() {
  const [wanted, setWanted] = useState<Stage | undefined>(() => (location.hash.slice(1) as Stage) || undefined);
  const { state, error, saving, update } = useStore(wanted);
  const switchTo = (st: Stage) => { history.replaceState(null, "", `#${st}`); setWanted(st); };
  const [copied, setCopied] = useState(false);
  const [help, setHelp] = useState(false);

  // dark by default (a video reads best on a dark surround); the light theme is the Motion Kit daylight room
  const [theme, setTheme] = useState<"dark" | "light">(() => { try { return localStorage.getItem("theme") === "light" ? "light" : "dark"; } catch { return "dark"; } });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const flipTheme = () => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); try { localStorage.setItem("theme", next); } catch { /* private window */ } };

  useEffect(() => {
    if (state?.manifest) document.title = `${state.manifest.project} · ${state.manifest.stage} · Clap`;
  }, [state?.manifest]);

  if (error) return <div className="fatal">Server unreachable: {error}</div>;
  if (!state) return <div className="fatal muted">Loading…</div>;
  if (!state.manifest || state.errors.length) {
    return (
      <div className="fatal">
        <h1>Invalid manifest</h1>
        <p className="mono">{state.root}/review/manifest.json</p>
        <ul>{state.errors.map((e, i) => <li key={i} className="mono">{e}</li>)}</ul>
        <p className="muted">This page reloads by itself as soon as the file is fixed.</p>
      </div>
    );
  }
  const m = state.manifest;
  const r = state.review!;
  const stageStatus = (st: Stage) => r.stages?.[st]?.status ?? "in_review";
  const stages = state.stages || [m.stage];

  const copy = async () => {
    await navigator.clipboard.writeText(reviewToText(r, m));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><ClapIcon />Clap</div>
        <div className="crumbs">
          <b className="project">{m.title || m.project}</b>
          <div className="seg stage-switch" title="Switch between the storyboard and the final video">
            {(["storyboard", "final"] as Stage[]).map((st) => (
              <button key={st} className={m.stage === st ? "on" : ""} disabled={!stages.includes(st)}
                title={stages.includes(st) ? `${STATUS[stageStatus(st)]}${state.gateStage === st ? " · waiting on this review" : ""}` : "Not generated yet"}
                onClick={() => switchTo(st)}>
                <span className={`dot ${stageStatus(st) === "approved" ? "approved" : stageStatus(st) === "changes_requested" ? "changes" : ""}`} />
                {st === "storyboard" ? "Storyboard" : "Final video"}
              </button>
            ))}
          </div>
          <span className="meta">round {m.round} · {m.canvas.w}×{m.canvas.h}{m.canvas.fps ? ` · ${m.canvas.fps} fps` : ""}</span>
        </div>
        <div className="top-right">
          <span className={`status-chip ${stageStatus(m.stage)}`}>{STATUS[stageStatus(m.stage)]}</span>
          <span className={`save ${saving}`}>{saving === "saving" ? "saving…" : saving === "error" ? <><Icon name="warn" size={13} /> save failed</> : "saved"}</span>
          <button className="ghost small" onClick={copy}><Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy as text"}</button>
          <button className="ghost small icon-only" onClick={() => setHelp((h) => !h)} title="Keyboard shortcuts" aria-label="Keyboard shortcuts"><Icon name="keyboard" /></button>
          <button className="ghost small icon-only theme-toggle" onClick={flipTheme}
            title={theme === "dark" ? "Thème clair" : "Thème sombre"} aria-label={theme === "dark" ? "Thème clair" : "Thème sombre"}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </header>
      {m.notes && <div className="notes">{m.notes}</div>}
      {help && <Help stage={m.stage} onClose={() => setHelp(false)} />}
      {m.stage === "storyboard"
        ? <Storyboard key={`sb-${m.round}`} m={m} review={r} update={update} />
        : <Final key={`fi-${m.round}-${m.media?.video}`} m={m} review={r} update={update} />}
    </div>
  );
}

/** A clapperboard, drawn in the accent colour. */
function ClapIcon() {
  return (
    <svg className="brand-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" opacity="0.9" />
      <path d="M3.2 8.6 19.6 3.4l.9 2.9L4.1 11.5z" fill="currentColor" />
      <path d="m7.4 7.3 2.2 2.6M11.9 5.9l2.2 2.6M16.4 4.5l2.2 2.6" stroke="var(--bar)" strokeWidth="1.6" />
    </svg>
  );
}

function Help({ stage, onClose }: { stage: string; onClose: () => void }) {
  return (
    <div className="help" onClick={onClose}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <div className="help-head"><h3>Shortcuts</h3><button className="ghost small icon-only" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
        {stage === "storyboard" ? (
          <ul>
            <li><kbd>←</kbd>/<kbd>→</kbd> previous / next panel</li>
            <li><kbd>A</kbd> approve and go to the next · <kbd>X</kbd> needs changes</li>
            <li>Click in an image: comment pinned to that point · <kbd>C</kbd> general comment</li>
            <li><kbd>G</kbd> grid view · <kbd>Esc</kbd> cancel</li>
          </ul>
        ) : (
          <ul>
            <li><kbd>Space</kbd> play/pause · <kbd>L</kbd> play, then 1× → 1.5× → 2× · <kbd>K</kbd> pause · <kbd>J</kbd> −2 s</li>
            <li><kbd>,</kbd>/<kbd>.</kbd> or <kbd>←</kbd>/<kbd>→</kbd> frame by frame · <kbd>Shift</kbd> = 1 s</li>
            <li>Click in the video: selects the exact element and opens a comment · <kbd>Alt</kbd>+click next element under the cursor</li>
            <li>Click a timeline block: select it and move the playhead to its start · drag on the ruler: range</li>
            <li><kbd>C</kbd> comment the selection · <kbd>[</kbd>/<kbd>]</kbd> previous / next comment · <kbd>Esc</kbd></li>
          </ul>
        )}
        <p className="muted">Comments are saved to <span className="mono">review/review.json</span>. Then tell Claude "apply the review".</p>
      </div>
    </div>
  );
}
