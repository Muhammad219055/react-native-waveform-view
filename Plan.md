# rn-waveform — pre-release plan

Target: publish **0.1.0-beta.1**, gather real feedback, then harden toward 1.0.

The library is extracted from a shipping app, so the code works on Android in one
real product. What it has never had is an independent build, an iOS run, or a
measured budget. Everything below exists to close those gaps — not to add features.

## What we are protecting

Two properties decide whether this library is worth using over the alternatives.
Every phase below is judged against them.

**Lightweight** — a waveform view should not reshape someone's app.

| Budget | Target | How we check |
| --- | --- | --- |
| Runtime dependencies | zero (peers only) | `npm pack`, inspect `dependencies` |
| Packed size | ≤ 60 KB source, ≤ 150 KB with `lib/` | `npm pack --dry-run` |
| Peer deps | reanimated, gesture-handler, svg — no more | review at API freeze |
| Public API | 1 component + ~6 functions | `src/index.ts` diff |

**Smooth** — it must hold 60fps while the audio plays and the user scrubs.

| Budget | Target | How we check |
| --- | --- | --- |
| Frame time while playing + scrubbing | p50 ≤ 8ms, p95 ≤ 16ms | `adb shell dumpsys gfxinfo <pkg>` |
| Extra memory, 2-hour file open | ≤ 25 MB | `dumpsys meminfo` before/after |
| JS thread blocked by the view | never > 5ms in a frame | systrace / profiler |
| Quick pass, 60-minute file | ≤ 1.5s to first bars | timed in the example app |
| Full decode, 60-minute file | ≤ 45s, background priority | timed in the example app |

A phase is not done until its budgets are measured and written down. Guessing at
performance is what cost us the most time building this in the first place.

---

## Phase 0 — Repo and identity

Small, but everything else assumes it.

- [x] Rename: npm package `react-native-waveform-view` (name tokens match the query
      people actually search), published in parallel as the short alias `rn-waveform`
      from `alias/`; component `<Waveform>`, data type `WaveformData`
- [x] `git init`, first commit, push to a public repo (remote configured)
- [x] Fill `author`, `homepage`, `repository` in `package.json`; author in `LICENSE`
- [x] `CHANGELOG.md` (Keep a Changelog format)
- [x] `npm pack --dry-run` — 19.8 KB packed, 60.3 KB unpacked, 14 files (a stray
      Gradle build report was shipping; `files` now excludes build output)
- [x] Re-measure after `bob build` adds `lib/`, and hold the ≤ 150 KB budget
      (measured: 41.9 KB packed, 168.4 KB unpacked, 45 files)

**Done when:** a clean clone typechecks and tests pass with `npm install && npm test`. (VERIFIED)

## Phase 1 — Example app

Nothing can be verified without one, and it doubles as the thing users copy.

- [ ] `example/` — bare React Native app (new arch), library linked by path
- [ ] Wire to an *external* player (`react-native-nitro-sound`), proving the
      bring-your-own-player claim end to end: play/pause, speed, seek
- [ ] Fixture audio committed or generated: 10s, 3min, 23min, 2h; mp3, m4a, wav, opus; mono and stereo
- [ ] Screens: decode-on-open, decode-once-and-store, display-only (no `onSeekEnd`)

**Done when:** the example runs on an Android device and an iOS simulator.

## Phase 2 — iOS verification

The iOS decoder has been written but never compiled. Treat it as unproven.

- [ ] Compile `ios/RNWaveform.mm`; fix build errors
- [ ] Run every fixture through both platforms; dump `overview`/`detail` to JSON
- [ ] Compare platforms bar-by-bar — same file should agree within a small tolerance;
      investigate any systematic offset (codec priming/delay is the likely suspect)
- [ ] Confirm behaviour on a file iOS cannot open (clear rejection, no hang)

**Done when:** iOS and Android produce visually identical waveforms for all fixtures,
and the difference is quantified in the README.

**Risk:** if the two platforms disagree structurally, this phase grows. It is the
single most likely source of schedule slip, which is why it comes before polish.

## Phase 3 — Tests

Currently 4 component tests. The decoding and state layers have none.

- [ ] `decode.ts`: timeout, in-flight dedupe, cache hit, invalid payload rejection,
      missing-native-module error
- [ ] `normalize.ts`: silence floor, loud/quiet files normalizing alike, huge arrays
      (no spread-argument limit)
- [ ] `useWaveform.ts`: quick-then-full ordering, late quick never overwrites full,
      `stored` renders on first frame, path change mid-flight
- [ ] `Waveform.tsx`: the sync clock — drive the frame callback with fake timestamps
      and assert the position tracks, corrects smoothly, snaps only on a real seek,
      and ignores stale reports after a scrub
- [ ] Native parity script from Phase 2, kept as a fixture test

**Done when:** every exported function has tests and the sync clock is covered.
The clock is the hardest part of the library and the part with no coverage today.

## Phase 4 — Performance and memory

Measure against the budgets above, on a mid-range Android device, not an emulator.

- [ ] Baseline: frame times playing, scrubbing, and flinging a 23-minute file
- [ ] Memory with a 2-hour file; watch the SVG tile bitmaps (each `<Svg>` on Android
      holds its own bitmap — this is the main memory risk)
- [ ] Tune `CHUNK` / `RADIUS` / `RECENTER` against those numbers; today's values
      (64 / 6 / 2) were reasoned about, not measured
- [ ] Confirm the Reanimated synchronous-UI-props flag actually helps; if it does,
      the README must state it is required, not optional
- [ ] Decode timings per fixture; confirm the JS thread stays free during decode

**Done when:** every budget has a measured number recorded in `Plan.md` or the README.

## Phase 5 — API freeze and weight audit

Last chance to remove things; after publishing they are someone's dependency.

- [ ] Review every prop: does each earn its place? Cut what the example never uses
- [ ] Decide `getDurationSeconds` — useful, but is it this library's job?
- [ ] Confirm zero runtime dependencies and check packed size against budget
- [ ] `bob build` output: commonjs, module, and working `.d.ts`
- [ ] Verify against RN 0.76+ old arch *and* new arch (the module is a legacy bridge
      module relying on interop — confirm it works, and note when interop retires)

**Done when:** `src/index.ts` is final and the package installs cleanly in a fresh app.

## Phase 6 — Docs and publish

- [ ] README: honest limitations, the comparison table, the flag requirement
- [ ] A GIF of scrubbing a long file — this is the whole pitch in two seconds
- [ ] Troubleshooting: native module not found, missing rebuild, missing peers
- [ ] `npm publish --tag beta` as `0.1.0-beta.1`; git tag
- [ ] Publish `alias/` as `rn-waveform@0.1.0-beta.1` immediately after, so both names
      resolve and the alias never points at a version that does not exist

**Done when:** it installs from npm into a fresh app and renders a waveform.

---

## Phase 7 — Discovery (so people can find it)

npm search ranks almost entirely on **name token match** — a package called
`react-native-waveform-recorder` outranks better-known libraries for "react native
waveform" on the strength of its name alone. Everything here is the work that
remains now the name is settled: the package takes the searchable name, with
`rn-waveform` published alongside as an alias.

**npm**
- [x] Description leading with "React Native audio waveform"
- [x] 30+ keywords covering the real queries: audio-waveform, scrubber, seekbar,
      voice-note, podcast, waveform-generator, amplitude, pcm
- [ ] `repository`, `homepage` and `bugs` filled — npm shows and indexes these
- [ ] Publish with provenance (`npm publish --provenance`) for the verified badge
- [ ] Keep the alias version in lockstep with the main package on every release

**GitHub** (the top Google result for most library queries)
- [ ] Repo description: "React Native audio waveform — scrolling waveform scrubber
      for Android and iOS, works with any audio player"
- [ ] Topics: `react-native`, `audio`, `waveform`, `audio-waveform`, `scrubber`,
      `android`, `ios`, `reanimated`, `audio-visualizer`, `voice-notes`
- [ ] Demo GIF at the top of the README — it is what gets shared
- [ ] Release notes on every tag (indexed, and they date-stamp the project as alive)

**README as the landing page**
- [x] H1 plus a one-line description carrying the primary phrase
- [x] FAQ with question headings matching real searches ("How do I add a waveform to
      react-native-track-player?") — these are what Google surfaces as snippets
- [x] Alternatives table naming competitors: captures "X vs Y" searches and is the
      honest thing to publish anyway

**Inbound links** (the only real lever on ranking; do these after the beta works)
- [ ] PR to `awesome-react-native` under Audio
- [ ] A write-up of the sync clock and the 100ms-per-bar approach: dev.to, plus
      r/reactnative. Technical posts about a hard problem age better than launch posts
- [ ] Answer the existing Stack Overflow questions about waveforms with
      `react-native-track-player` — they already rank; link where genuinely relevant
- [ ] Ask the two or three apps that adopt it to be listed in the README

**Measure**
- [ ] Track weekly downloads and the npm search position for "react native waveform"
      and "react native audio waveform" monthly. If position does not move after the
      beta, the name is the bottleneck, not the content.

## Explicitly not in 0.1

Each of these is a feature someone will ask for. Saying no keeps the surface small.

- **Live recording waveform** — a different component with different constraints
- **Remote URLs** — callers can download first; streaming decode is its own project
- **Playback** — the entire point is that it does not own your player
- **Web** — untested; `react-native-svg` may carry it for free, but claiming it means supporting it
- **TurboModule codegen** — do it when interop actually retires, with a measured reason
- **Skia renderer** — only if Phase 4 shows SVG cannot hold the budget

## Open risks

1. **iOS is unproven.** Mitigated by making it Phase 2, before any polish.
2. **SVG bitmap memory on Android.** A 2-hour file is the stress case; Phase 4 measures it.
   The fallback is smaller tiles, or Skia — a large change, so we want the number early.
3. **Reanimated version drift.** The sync clock uses `useFrameCallback` and `withDecay`;
   pin the tested range in peer deps.
4. **Android codec variance.** Decoding differs across vendors; the fixture set is the defence.
