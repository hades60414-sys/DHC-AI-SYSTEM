---
name: video-studio
description: Produce narrated, animated explainer videos (MP4) from a storyboard - GSAP motion graphics rendered frame by frame in headless Chrome, Taiwan Mandarin neural voice-over with word-timed subtitles, generated music and SFX with ducking, loudness-normalized and QA-checked. Use when the user asks for a video, animation, teaser, explainer, 動畫, 影片, 簡報轉影片, 旁白, 配音, 字幕, or motion graphics. Not for screen recording or editing camera footage.
---

# video-studio

Pipeline: `storyboard.json` (scenes, narration with `{cue:name}` marks) -> voice -> `build/timeline.json` -> scenes animated on one GSAP master timeline -> frame-accurate render -> mix -> mux -> `qa`. Everything reads the same timeline, so picture, voice, subtitles, and SFX stay in sync. No Python anywhere.

Commands (run from this skill folder; `<dir>` is the project folder):
`node scripts/studio.mjs setup | init <dir> | voice <dir> | timeline <dir> | preview <dir> [--at 1.5,7] | render <dir> [--draft] [--blur 4] [--workers 8] [--from s --to s] | mix <dir> | mux <dir> | qa <dir> | all <dir>`

## Steps

1. **Setup once per machine.** `setup` installs pinned gsap, playwright-core, lucide-static into `VIDEO_STUDIO_HOME` (default `~/video-studio`) with lifecycle scripts disabled, fetches fonts and Kenney CC0 sounds from `assets.json` (sha256-pinned), and renders the generated music and SFX library. Done when it prints `0 fetched now` on a rerun.
2. **Brief.** Settle purpose, audience, length (teaser 45–75 s, explainer 2–4 min), and voice. Online voices send the script text to Microsoft: get the user's consent, then strip IPs, hostnames, account names, and customer data from `say` text. Done when consent and the cleaned script are confirmed.
3. **Storyboard.** Read [references/craft.md](references/craft.md) first. `init <dir>`, then write `storyboard.json`: one idea per scene, 4–10 s each, `{cue:x}` where a visual must land on a word. Starting from a PowerPoint deck: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/pptx-export.ps1 -Pptx <deck> -Out <dir>/deck` gives `slide-NN.png` and `slides.json` (title, text, speaker notes); write narration from the notes, rebuild the key slides as animated scenes, and place a slide image with `<img>` where animation adds nothing. Done when every scene has `id`, `say`, and the cues its animation needs.
4. **Voice and timeline.** `voice` then `timeline`. Read `build/final.srt`; reword or use `lexicon` (spoken form only) for mispronounced terms. Done when subtitles read as natural phrases.
5. **World and scenes.** Lay out `index.html` + `style.css` as one world the camera travels (see the example). Write `scenes.js`: one exported function per scene id, every tween placed with `at(cue, offset)`. Done when `preview` boots without errors.
6. **Look.** `preview` stills at each scene's key cue; open them with Read. Fix overlaps, text under 24 px on screen, empty boxes, clutter outside the focus. Done when every still passes the craft bar.
7. **Draft.** `render --draft`, `mix`, `mux`, `qa`; open `build/qa/contact.jpg`. Done when `qa` has zero FAIL and the 20 tiles are 20 different frames.
8. **Final.** `render --blur 4 --workers 8`, `mix`, `mux`, `qa`. Deliver only on zero FAIL; send the MP4 with `build/final.srt`.

## Scene code rules

- Scenes are a pure function of time: tweens and timelines only. No `setTimeout`, `Date`, or unseeded `Math.random`; loops use finite `repeat` sized from `total`.
- Hide-then-reveal comes from the recipes' `fromTo` initial states. Set any other start state at build time with `gsap.set`; a `tl.set(..., 0)` is skipped until the playhead moves, so the element flashes on frame 0. Stacking several `fromTo` on one property needs `immediateRender: false` on the later ones (see `references/gsap/gsap-core/README.md`).
- Text a wide shot shows must be big enough after camera scale: on-screen size = CSS px x shot scale, minimum 24 px. Keep content above the bottom 180 px (subtitles).
- Animated overlays that must sit on top of cards need `z-index`.
- Put flows (`packets`) and pipes in separate `<g>` layers so a whole flow can be dimmed at once.

## Reference

- Recipes (`runtime/recipes.js`): `reveal`, `exit`, `pop`, `title` (mask-up by char), `typewriter`, `scramble`, `count`, `draw` (stroke), `packets` (dots along a path), `follow` (element along a path), `camera` (center x,y at scale; duration 0 cuts), `link` / `route` / `anchor` (connectors), `pulse`, `glow`, `stamp`, `pointer`, `bokeh`, `$`, `$$`. Icons: `<i data-icon="lucide-name">`.
- Runtime ctx per scene: `{ tl, at(cue, offset), start, end, dur, total, data }`. Cues: `start`, `voiceStart`, `voiceEnd`, `end`, plus each `{cue:}` in `say`.
- Storyboard fields: `canvas{width,height,fps}`, `voice{engine: winrt, name, rate, pitch}`, `music{file, gainDb}`, `loudness`, `defaults{lead,pad,overlap,gap,minSec}`, `lexicon`, `scenes[]{id, say, minSec, lead, pad, sfx[]{at: seconds|"cue:x", file, gainDb, offset}, data}`. Asset paths resolve in the project first, then `VIDEO_STUDIO_HOME/assets` (`gen/music/*`, `gen/sfx/*`, `sfx/kenney/*`, `fonts/*`).
- Voices: `winrt` = offline Windows voices Yating / Zhiwei / Hanhan (no network, no key). For studio-grade neural voices, add an Azure AI Speech engine with the user's own key; the online Edge read-aloud endpoint has no public licence and is not included.
- Worked example: [examples/architecture-teaser](examples/architecture-teaser) (65 s, nine scenes, one camera world). GSAP API: [references/gsap/](references/gsap/). Licenses: `VIDEO_STUDIO_HOME/assets/LICENSES.md`.
- Measured on the 28-thread office machine: a 65 s piece drafts in about 66 s (6 workers, ~30 frames/s); the `--blur 4` final runs ~4.4 frames/s with 3 workers, about 7.5 min.

## Gotchas

- Each render worker commits about 2.5 GB; `render` caps workers so 3 GB of Windows commit stays free and says so. The cap is measured once at start, so keep other heavy work (more renders, local models, big builds) off the machine during a final render. `0x800705AF` or `0xC000012D` from any program means the commit limit ran out; close heavy work and rerun.
- Write render output to a log file; a failing worker's error is otherwise lost in progress lines.
- Regenerate sounds by overwriting (`generateSounds({ force: true })` in `scripts/audio-gen.mjs`) where file deletion is blocked.
