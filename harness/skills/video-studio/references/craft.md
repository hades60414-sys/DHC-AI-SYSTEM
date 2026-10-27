# Craft bar for explainer videos

Read before writing the storyboard and again before the final review. Every rule here is checkable on a still frame, the contact sheet, or `qa` output.

## Story
- First 5 seconds state the tension in one line ("工作在牆內，AI 在牆外"). No logo intro, no agenda slide.
- One idea per scene. If a scene needs two sentences that are not cause and effect, split it.
- Show the mechanism, not the noun: data visibly moves along a path, a gate visibly stops an action, a citation visibly links to its source paragraph.
- Build complexity progressively: the architecture diagram grows node by node across scenes instead of appearing complete.
- End on the payoff line plus the product name, held still for 2 seconds of music tail.

## Pacing
- Narration 4–5.5 Chinese characters per second. Edge voices at `rate: "+0%"` land near 5; slow to `-5%` for dense scenes.
- Scenes 4–10 s. Over 10 s means the scene holds two ideas.
- Leave 0.3–0.6 s after each sentence (`pad`). Silence before a key reveal is a tool: put the reveal on a `{cue:}` right after a comma.
- Total: teaser 45–75 s, explainer 2–4 min.

## Visual system
- One background family for the whole video (deep navy gradient + faint grid + vignette + 2–3 % grain). Never a flat color.
- Palette: two accents at most (one warm for action and highlights, one cool for system and data) over neutrals. Red only for blocked or danger.
- Type: display 84–120 px bold, headings 56–64 px, body 36–44 px, labels 26–30 px. Nothing under 24 px at 1080p. Chinese lines ≤ 16 characters on screen.
- Icons from one set with one stroke width. Mixed icon styles read as stock.
- Layout on a 12-column grid with 96 px safe margins; subtitles own the bottom 180 px, so keep content above it.
- Depth: background layer slower and blurred, content layer sharp, highlight layer glows. Shadows soft and large, not hard drop shadows.

## Motion
- Every frame moves: the scene camera drifts (scale 1.00→1.04 or a 20–40 px pan) for the whole scene, so `qa` never reports a frozen frame.
- Entrances `expo.out` or `power3.out`, 0.5–0.9 s; exits faster than entrances (0.3–0.5 s, `power2.in`); camera and layout moves `power2.inOut` 0.8–1.4 s. `back.out(1.6)` only for small pops (icons, badges).
- Stagger lists and characters 0.03–0.08 s. Overlap consecutive animations; nothing waits for the previous tween to fully end.
- One focal motion at a time. While the camera moves, content holds; while content builds, the camera only drifts.
- Lines draw (stroke reveal) before packets travel them. Packets move with `power1.inOut` and a short trail.
- Text reveals: mask-up by line or character for titles, scramble/decode for technical labels, typewriter only for terminals.
- Transitions carry meaning: zoom into a node to enter its detail scene, pull back out to return. Hard cuts are fine on a beat; crossfades are the fallback, not the default.
- Motion blur (`--blur 4`) on the final render; preview without it.

## Sound
- Music bed ducks under the voice automatically; pick calm, steady tracks without vocals or strong melody hooks.
- Un-ducked bed sits about -26 LUFS against the -16 LUFS voice (10–14 LU below). `mix` prints the estimate; adjust `music.gainDb` until it says ok.
- SFX mark meaning, not every element: a whoosh on scene transitions, a soft click or pop when a key node lands, a low thud when a gate blocks. 4–10 SFX per minute, set 8–14 dB under the voice (`gainDb: -10` to `-16`).
- Put SFX on cues, offset -0.05 s so the sound leads the picture slightly.
- Final mix: -16 LUFS integrated, true peak ≤ -1 dBTP (the `mix` step enforces it).

## Review loop
1. `preview` stills at each scene's start, its key cue, and its end. Look for overlaps with the subtitle zone, text under 24 px, clipped glyphs, and empty or crowded areas.
2. Render without blur, run `qa`, read `contact.jpg`. Twenty tiles should look like twenty different frames, and color and type should match tile to tile.
3. Fix, then the final render with `--blur 4`, `qa` again, and deliver only on zero FAIL.
