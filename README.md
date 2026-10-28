# Clap

A local review app for videos (formerly `aisance-video-editing`). It has two modes:
1. **Storyboard**: approve each panel, pin comments on a precise point of a still, or of the panel's passage playing from a draft render of the whole video (an animatic).
2. **Final**: play the render frame by frame and click any element (a card, one line inside a card, a caption word, a screen window). You can also click any block of the multi-track timeline (cuts, SFX, music) and comment it.

Comments go back to Claude through a file, not through copy-paste.

It is a **tool**, independent of any skill. A skill writes `review/manifest.json` in its project folder, the user reviews, the app writes `review/review.json`, and the skill reads it when the user says "apply the review". The tool knows nothing about reels: everything specific lives in the skill's adapter (for aisance-reel: `scripts/review_manifest.py`).

Works for vertical 9:16 reels and long 16:9 videos. The layout follows `canvas`, the timeline zooms and only draws what is in view, and the waveforms are computed once by ffmpeg on the server and cached.

## Install
```
git clone https://github.com/JulienSnsnCode/aisance-video-editing && cd aisance-video-editing
npm ci && npm run build && npm link     # puts `clap` (and the old name `aisance-video-editing`) on the PATH
```
Requires Node 22+ and ffmpeg (waveforms).

## CLI
```
clap open <projectDir> [--port N] [--no-open]   # serve <projectDir>, open the browser
clap validate <projectDir>                      # check review/manifest.json (exit 1 on errors)
clap status <projectDir>                        # {stage, round, status, open, panels} as JSON
clap comments <projectDir> [--all]              # open comments as plain text
```
The server listens on 127.0.0.1 only and serves `<projectDir>` read-only. Paths that leave the project are refused, and so are symlinks pointing outside it. The one exception is a media file the manifest names explicitly (a music track linked from another folder, say). The page reloads by itself when the manifest or review.json changes on disk.

## The contract
Schemas: `schemas/manifest.schema.json`, `schemas/review.schema.json`. All paths in the manifest are relative to the `review/` folder.

### review/manifest.json (written by the skill)
```jsonc
{
  "schema": 1, "project": "my-reel", "title": "optional", "round": 1,
  "stage": "storyboard" | "final",
  "canvas": { "w": 1080, "h": 1920, "fps": 30 },          // 1920x1080 for 16:9
  "chapters": [{ "id", "title", "start", "end" }],        // optional, long videos
  "notes": "optional banner text",

  // storyboard
  "panels": [{
    "id": "hook", "title": "title · WHEN TO USE IT.", "kind": "title", "chapter": "ch1",
    "start": 3.3, "end": 6.75,
    "images": ["frames/hook_in.png", { "src": "frames/hook_rest.png", "label": "rest", "t": 4.4 }],
    "description": "what is on screen and how it moves", "excerpt": "the spoken words",
    "source": { "file": "../cards/beats.json", "pointer": "/beats/1" }, "data": {},
    "clip": { "start": 3.3, "end": 6.75 }   // optional: play this passage of media.video (an animatic) in the panel
  }],
  "media": { "video": "animatic.mp4" },     // storyboard: optional preview video the panel clips play from

  // final
  "media": { "video": "../renders/my-reel-v3.mp4", "audio": "optional" },
  "tracks": [{
    "id": "cards", "label": "Cards", "kind": "component",  // segment | component | word | marker | audio-cue | audio | region
    "items": [{
      "id": "usages", "start": 22.1, "end": 30.6, "label": "...", "text": "...",
      "rid": "usages",                    // data-rid of the matching element in an html layer
      "bbox": [x, y, w, h],               // canvas px, for picking without a layer (captions, regions)
      "source": { "file": "...", "pointer": "..." }, "data": {},
      "children": [{ "id": "usages.items.1", "rid": "usages.items.1", "start": 24.7, "end": 30.6 }]
    }]
  }, { "id": "mix", "kind": "audio", "src": "../renders/my-reel-v3.mp4" }],
  "layers": [{
    "kind": "html", "src": "../cards/index.html", "timeline": "main",  // window.__timelines[timeline], a paused GSAP timeline
    "size": [1080, 1920],          // page viewport
    "crop": [0, 0, 1080, 864],     // page region shown...
    "rect": [0, 0, 1080, 864],     // ...at this canvas rect
    "offset": 0, "track": "cards",
    "start": 12.0, "end": 19.5     // optional: the layer only exists in [start, end] (one page per graphic, long videos)
  }]
}
```
Ids must be unique across the manifest and **stable across rounds**: comments are keyed on them.

**Long videos.** Give each graphic its own page and its own layer, with `offset` = `start` = when it appears and `end`. The app only loads the layers within 20 s of the playhead and drops the others, so a 20-minute video with 60 graphics keeps a handful of iframes alive.

**Element picking.** For an html layer, the app loads the page in an off-screen iframe and seeks the GSAP timeline to the video time. It then asks the DOM which visible `[data-rid]` elements sit under the click, deepest first. An element counts only if it is painted and its opacity is above 0.05. Items with a `bbox` are hit-tested by time and rectangle. Candidates are sorted smallest first; Alt+click cycles through them.

### review/review.json (written by the app, comment status by the skill)
```jsonc
{
  "schema": 1, "round": 1, "stage": "final", "status": "in_review" | "changes_requested" | "approved",
  "panels": { "hook": "approved", "usages": "changes" },   // storyboard: pending | approved | changes
  "approved_round": 1,                                       // final: the user approved this round
  "comments": [{
    "id": "c-…", "round": 1, "stage": "final",
    "target": { "track": "cards", "item": "usages", "sub": "usages.items.1", "label": "item 2", "source": { … } },
    "t": 29.5, "frame": 885, "range": [28.0, 30.0], "point": { "x": 0.5, "y": 0.24 },
    "shot": "shots/c-….png",              // the frame with the outline and the pin, for Claude to Read
    "text": "…", "status": "open" | "resolved" | "wontfix", "resolution": null, "recheck": false
  }]
}
```
The status is computed:
- storyboard: approved when every panel is approved and no comment is open;
- final: approved when `approved_round == round` and no comment is open.

**What the skill does on "apply the review":**
1. Read the open comments of the current stage, and open each shot.
2. Apply the edits.
3. Set `status: "resolved"` (or `"wontfix"`) with a one-line `resolution`.
4. Write a new manifest with `round + 1`.

The skill never touches `panels` or `approved_round`. The app keeps the comment history. Comments resolved in an earlier round show "recheck" until the user confirms them. If the skill writes review.json while the user is editing, the save is retried: the skill's resolutions win for those comments, the user's new comments are kept.

## Develop
```
clap open <dir> --port 4300 --no-open   # API + files
npm run dev                              # Vite on :5173, proxies to :4300
npm test && npm run typecheck
```
