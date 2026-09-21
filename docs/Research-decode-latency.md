# Decode latency — research

**Symptom:** a full decode of a 3-minute file takes 3+ minutes. That is roughly
**1× real time**, which is absurd for audio decoding: the platform decoder alone
should manage 20–50× real time, and we run four of them in parallel.

Something is throttling us by an order of magnitude or more. This document is
research only — no code has been changed. It ranks the suspects by expected
impact, states the experiment that would confirm each, and lists the candidate
fixes with their cost.

---

## Suspect 1 — We put every decode thread in Android's background cgroup

**This is almost certainly the main cause, and it is two lines of code.**

`AudioWaveform.read()` starts each segment thread with:

```kotlin
android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
```

and the native module does the same again on the executor thread before calling it.

What that actually does on Android is not "be slightly politer". A thread whose
nice value is at or above `THREAD_PRIORITY_BACKGROUND` (10) is moved into the
**background scheduling policy**, which means:

- **~5% of total CPU time** once the device is under any contention
  ([AndroidScheduling](https://github.com/keesj/gomo/wiki/AndroidScheduling))
- **restricted to the background `cpuset`** — historically core 0 only, while the
  foreground app gets every core
  ([Thread Scheduling in Android](https://www.androiddesignpatterns.com/2014/01/thread-scheduling-in-android.html))

Two consequences, and the second one is the nasty one:

1. A ~20× slowdown whenever anything else wants the CPU — which is always,
   because the user is looking at a screen that is playing audio.
2. **Our four "parallel" decoders are not parallel at all.** They are pinned to
   the same little core and time-slice against each other. The parallelism we
   added to fix this problem cannot work while this line is present.

A 20× throttle on something that should run at 25× real time lands almost exactly
on the 1× real time we are seeing.

**Experiment that settles it:** record wall time and
`Debug.threadCpuTimeNanos()` per decode thread. If wall time is many times the
CPU time, the thread is starved by the scheduler, not doing slow work. Then
re-run with `THREAD_PRIORITY_DEFAULT` and compare.

## Suspect 2 — Queueing behind the backfill (app side, not the library)

Even with a fast decoder, the user waits on a **queue**, not on their file.

In HeerSeak, `AudioMetadataModule` runs all full decodes on a **single-thread
executor**, and `backfillMissingWaveforms()` walks every unprocessed file in the
library, one at a time, on app start. Opening a file whose waveform is not yet
stored puts that decode *behind every file already queued*.

With 20 files queued, a "3-minute wait" says nothing about decode speed. Worse,
bumping `LOUDNESS_VERSION` (we did, to v2) invalidates every stored waveform and
re-queues the entire library at once.

**Experiment:** log queue depth and the time between request and decode start,
separately from decode duration. My expectation is that wait ≫ decode.

**Fix direction:** the user-visible request must preempt the backfill — pause or
cancel the background job while a foreground decode runs, and keep a dedicated
thread for on-demand work (the quick pass already has one).

## Suspect 3 — MediaCodec per-buffer overhead

Real, but secondary. Each buffer crosses into the `mediaswcodec` process and
back; an MP3 frame is 1152 samples (~26ms), so a 3-minute file is ~7,000 round
trips each way. One developer measured
[30 seconds for a 4-minute MP3](https://imnotyourson.com/enhance-poor-performance-of-decoding-audio-with-mediaextractor-and-mediacodec-to-pcm/)
with a naive loop — about 8× real time, still nowhere near our 1×.

Our loop already keeps the input queue full, which is the main fix people miss.
What remains: `dequeueOutputBuffer(info, 5_000)` blocks up to 5ms per idle pass,
and `IDLE_LIMIT` 200 means we can burn up to a second spinning at the end of a
stream.

**Worth knowing:** Android 17 ships
[in-process decoders](https://developer.android.com/media/platform/in-process-codecs)
for AAC and Opus (`c2.android.inproc.aac.decoder`) that remove the IPC entirely —
**~40% lower decoding latency**, opt-in via `MediaCodec.createByCodecName()` with
a fallback. Cheap to adopt, but only helps AAC/Opus on very new devices.

## Suspect 4 — Our own per-sample math

3 minutes of 44.1kHz stereo is ~15.9M samples, and we do per-sample work in
Kotlin with an inner loop over channels. On a normal core this is well under a
second; on one little core at 5% CPU it is not. **This only matters after
Suspect 1 is fixed** — and then the cheap wins are: use channel 0 instead of
averaging channels, and compute RMS from every Nth sample (energy is a
statistical measure; we are averaging into 20ms slices anyway).

## Suspect 5 — The emulator

All observations so far are from an emulator, where codecs are software x86
builds and the host is shared. Every number needs re-measuring on a real device
before we conclude anything about production.

---

## Candidate fixes, ranked

| # | Change | Expected gain | Cost | Risk |
|---|---|---|---|---|
| 1 | Drop `THREAD_PRIORITY_BACKGROUND` for user-visible decodes; restore real multi-core parallelism | **Potentially 10–20×** | Two lines | Uses more CPU while decoding — the point |
| 2 | Preempt the backfill for on-demand requests; separate queues | Removes minutes of queue wait | Small | Needs cancellation plumbing |
| 3 | **Stream partial results** — emit bars as they are produced | Perceived latency → near zero | Medium (event API) | Changes the module's contract |
| 4 | **Window-first decode** — decode around the playhead, extend outward | First paint in ~100ms for any duration | Medium-high | Seek/flush per window; stitching |
| 5 | Sparse sampling — decode X of every Y ms for the detail track | 3–5× throughput | Small | Lower fidelity; measure first |
| 6 | Cheaper math — single channel, every Nth sample | 2–4× on the math only | Small | Slightly noisier levels |
| 7 | In-process AAC/Opus decoders (Android 17+) | ~40% on those formats | Small | Version-gated |
| 8 | NDK `AMediaCodec` — drop JNI and Java buffer copies | Unknown, measure | Medium | More native code to maintain |
| 9 | Bundle C decoders (minimp3 / dr_wav / dr_flac / stb_vorbis) | Potentially order-of-magnitude; **one decoder for both platforms** | High | +native source, format coverage gaps (AAC), size |

Numbers 3 and 4 deserve emphasis because they attack the problem from the other
end: **the user does not need the whole file decoded, they need the part they are
looking at.** Even a slow decoder feels instant if the first 10 seconds of bars
arrive in 100ms and the rest fills in behind. If we do 1 + 2 + 3, the decoder's
raw throughput may stop mattering at all.

Number 9 is the big architectural option. [minimp3](https://github.com/lieff/minimp3)
is a single-header, SSE/NEON, ISO-conformant MP3 decoder; with `dr_wav`,
`dr_flac` and `stb_vorbis` it would cover most formats in-process on **both**
platforms, removing MediaCodec and AVFoundation from the hot path and making the
two platforms produce bit-identical results (which would also settle the iOS
parity work in Plan.md Phase 2). The cost is real native code and an AAC gap —
m4a/AAC is the most common recording format, so the platform decoder stays as a
fallback regardless. Do not consider this until 1–4 are measured.

## What I would measure first

One instrumented run, logging per file:

1. Wall time vs `Debug.threadCpuTimeNanos()` per decode thread — starvation check
2. Time from request → decode start (queue wait) vs decode duration
3. Decode-only baseline: same loop with the energy math removed, to split codec
   cost from our cost
4. 1 segment vs 4 segments, background vs default priority — four combinations
5. Same file on a physical device vs the emulator
6. Codec name actually selected (`codec.name`), and MB of PCM processed per second

That is a single afternoon and it turns every row in the table above from an
estimate into a number. Given how the last performance problem went — where I
assumed the decode loop was the bottleneck and the measurement said otherwise —
I would rather not skip it.

## Honest caveat on my own earlier claim

The comment at the top of `AudioWaveform.kt` says "the platform decoder (not our
code) is the bottleneck — roughly 25× real time for MP3 on slower devices". That
conclusion was drawn from measurements taken **with the background priority
already in place**, so it may have measured the throttle rather than the codec.
The parallel-segments design was built on that conclusion. If Suspect 1 is right,
the parallelism was a workaround for a self-inflicted wound, and may be
simplifiable afterwards.

---

# MEASURED RESULTS (2026-09-21)

Method: a standalone Java harness running the exact decode loop (MediaExtractor +
MediaCodec + 20ms slice math) on the device via `app_process` — **no app, no React
Native**, so nothing else can pollute the numbers. Device: Android emulator,
arm64-v8a. Test files: synthesized 3-minute tones, 128kbps, 44.1kHz stereo, as
both MP3 and AAC/m4a. Harness: `scratchpad/bench/Bench.java`.

## MP3 (`c2.android.mp3.decoder`), 180s file

| segments | nice | math | wall | CPU | × real time |
|---|---|---|---|---|---|
| 1 | 0 (default) | on | 6256ms | 912ms | 28.8× |
| 1 | **10 (background)** | on | **5968ms** | 721ms | **30.2×** |
| 4 | 0 | on | 2298ms | 1022ms | 78.3× |
| 4 | 10 (background) | on | 2258ms | 816ms | 79.7× |
| 8 | 0 | on | 1690ms | 1119ms | 106.5× |
| 1 | 0 | **off** | 5742ms | 493ms | 31.4× |

## AAC / m4a (`c2.android.aac.decoder`), 180s file

| segments | wall | CPU | × real time |
|---|---|---|---|
| 1 | 7426ms | 869ms | 24.2× |
| 4 | 2949ms | 1051ms | 61.0× |
| 8 | 2028ms | 1170ms | 88.8× |

## MP3, 23-minute file (1385s), same harness

| segments | wall | CPU | × real time |
|---|---|---|---|
| 1 | 67.7s | 8.1s | 20.4× |
| 2 | 30.3s | 9.3s | 45.7× |
| **4** | **19.1s** | 9.1s | **72.5×** |
| 8 | 22.8s | 12.1s | 60.7× (past the sweet spot on 4 cores) |

**A bug fell out of this.** The emulator reports **4 cores**, and the segment
formula is:

```kotlin
listOf(4, 2, 1).first { it <= max(1, cores - 1) && durationUs / it >= MIN_SEGMENT_US || it == 1 }
```

`4 <= max(1, 4-1)` is false, so on any 4-core device we use **2 segments, not 4** —
30.3s instead of 19.1s for this file, a **1.6× self-inflicted loss**. The
`cores - 1` cap assumes we are CPU-bound and should leave a core free. The
measurements say we are *latency*-bound: 4 segments on 4 cores is the best result,
and even 8 threads only cost 12.1s of CPU total. The cap should be based on
overlapping waits, not on core count.

Quick (sampled) pass, 64 bars: **856ms** MP3, **1017ms** AAC — CPU only 76-86ms.

Three full 4-segment decodes launched simultaneously: 4.5s each, **6s wall for all
three**.

## What the numbers say

**1. Suspect 1 was wrong. I need to say that plainly.**

Background priority made **no difference at all** (5968ms at nice 10 vs 6256ms at
nice 0 — if anything it was faster, which is measurement noise). The ~5% CPU
figure applies *under contention*; an idle device hands the background cgroup
whatever is free. I ranked this first and claimed "potentially 10-20×". It is
worth nothing here. It may still matter on a busy phone, but it is not the cause.

**2. The real bottleneck is waiting, not computing.**

Look at wall vs CPU on a single thread: **6256ms wall, 912ms CPU**. The thread is
idle ~85% of the time, blocked on round trips to the `mediaswcodec` process. That
is why throughput scales almost linearly with segment count (28.8× → 78× → 106×):
we are not adding compute, we are overlapping *waiting*.

**3. This explains why iOS is much faster — your observation was right.**

`AVAudioFile` decodes **in-process**. There is no IPC per buffer, so iOS never
pays the latency that dominates our Android number. It is not that our iOS code
is smarter; it is that Android's codec lives in another process and we ask it for
one small buffer at a time, synchronously. Android 17's
[in-process decoders](https://developer.android.com/media/platform/in-process-codecs)
exist precisely to remove this, and are documented at ~40% lower latency.

**4. Our own math is nearly free.** Turning it off saved 419ms of CPU and barely
moved wall time. Optimizing the energy loop would be a waste of effort.

**5. Decoding a 3-minute file takes 2-3 seconds, not 3 minutes.**

This is the important one. In isolation, the current code decodes your 3-minute
case in **2.3s** (4 segments), and three files at once in 6s. The reported 3+
minute wait is **60-100× worse than the decoder can explain**, so it is not decode
throughput. It has to be one of:

- **Queue depth** — full decodes share a single-thread executor, and the backfill
  walks the entire library on app start. Your file waits behind every queued file.
  Bumping `LOUDNESS_VERSION` to v2 invalidated every stored waveform and re-queued
  everything at once.
- **Repeated decoding** — a cache miss path that re-decodes on every open.
- **A much longer file than assumed** — at 24-30× single-threaded, a 60-minute
  recording takes ~2 minutes. If the 3-minute wait was for a long file, that alone
  explains it.
- **`content://` URIs** — untested here; worth measuring against a plain path.

I could not check the app's database to count queued files (blocked as PII), so
this needs either your answer — how many recordings are in the library, and how
long was the file that took 3+ minutes? — or an instrumented run in `example/`.

## Revised fixes, ranked by measured impact

| # | Change | Evidence | Cost |
|---|---|---|---|
| 1 | **Async MediaCodec (callback mode)** — stop blocking on `dequeueOutputBuffer` | wall/CPU 6.9:1 says 85% of the time is idle waiting | Medium |
| 2 | **More segments** — scale with cores; 8 gave 106× vs 78× at 4 | measured | Small |
| 3 | **Fix the queue** — on-demand preempts backfill | decode is 2.3s, so any minutes-long wait is queueing | Small |
| 4 | **Stream partial results** — draw bars as they arrive | perceived latency → ~0 regardless of throughput | Medium |
| 5 | In-process AAC/Opus decoders (Android 17+) | attacks the IPC directly, ~40% documented | Small |
| 6 | Bundled C decoders (minimp3 / dr_*) | removes IPC entirely; makes Android behave like iOS | High |
| ~~7~~ | ~~Drop background thread priority~~ | **measured: no effect on an idle device** | — |
| ~~8~~ | ~~Optimize the energy math~~ | **measured: 419ms of CPU total** | — |

## Fixed

**Segment cap (item found during measurement, not in the original suspect list).**
`AudioWaveform.kt` capped parallel segments at `cores - 1`, reserving a core "for
everything else". The benchmark shows segment threads spend ~85% of their time
blocked on the codec process, not running — they don't compete for CPU the way a
compute-bound thread would, so the reservation cost throughput for no measured
benefit: 2 segments instead of 4 on a 4-core device, a 1.6x loss (30.3s vs 19.1s
on the 23-minute file). Changed the cap from `cores - 1` to `cores`.

Fixed in `android/src/main/java/com/rnwaveform/AudioWaveform.kt`. Verified: a
forced (non-cached) `:react-native-waveform-view:compileDebugKotlin` through the
example app's real Gradle/Kotlin toolchain — BUILD SUCCESSFUL, 21/21 tasks
executed (not up-to-date), no new warnings or errors. The first attempt returned
UP-TO-DATE from a stale cache and was discarded rather than reported as a pass.

Not yet done: re-running the on-device benchmark against this *built* library
(rather than the standalone harness against source) to confirm the 1.6x holds
end to end — that needs the library actually wired into a running example app
(Phase 1), which is unbuilt beyond this compile step.

Items 1 and 2 are the throughput fixes; 3 and 4 are almost certainly what you
actually felt as "3+ minutes".

---

# ROOT CAUSE OF "STILL GOING" ON THE 2-HOUR FILE (2026-09-21, follow-up)

User-reported numbers from the example app's parity screen, on the real fixture
files (not synthetic): Android 3min=4.24s / 23min=33.91s / 2hr="still going,
idk when"; iOS 3min=0.40s / 23min=1.09s / 2hr=15.29s.

Three theories were tested in order, on the real `fixture_2h_stereo.mp3`
(7200.0s, MP3, 44.1kHz stereo, 64kbps CBR — confirmed via ffprobe, nothing
unusual about the file):

**1. Seek cost scaling with file size — ruled out.** Timed `seekTo()` at 0%,
10%, 25%, 50%, 75%, 90%, 99% into the real 2-hour file: every seek was 2ms, flat.
No scan-from-start behavior.

**2. Raw decode of the real file — not pathological.** The standalone harness
(no app, no bridge) decoded the actual 2-hour fixture in **102.6s at 4 segments
(70.1x realtime)** — consistent with earlier synthetic-file scaling, not a
cliff. This uses the *already-fixed* segment cap.

**3. Bridge/marshaling cost of the 72,000-element detail array — ruled out.**
Timed `Arguments.createArray()` + `pushDouble()` in a loop, in the real app's
own JNI environment (a temporary diagnostic in `MainActivity.onCreate`, removed
after): 1,800 → 7ms, 13,800 → 90ms, 72,000 → 460ms, 144,000 → 696ms. Roughly
linear (~5-6.5µs/element), nowhere near enough to explain the reported wait.

**4. The actual cause: an abandoned decode blocks every decode after it.**

- `decode.ts`'s `decodeWaveform()` wraps the native call in
  `Promise.race([nativeCall, timeout(120_000)])` — `FULL_TIMEOUT_MS = 120000`.
- `RNWaveformModule.kt` runs every full decode on
  `Executors.newSingleThreadExecutor()` — one thread, strictly serial.
- **`Promise.race` only makes the JS promise settle early. Nothing cancels or
  interrupts the native `Runnable` already running on that executor thread.**

So: the 2-hour decode (~102s fixed / ~160s estimated pre-fix, either way close
to or past the 120s ceiling) starts running on the executor. At 120s, the JS
promise times out and the UI shows a rejection for that fixture — but the
native decode is still running underneath, unaware anything gave up on it. The
parity screen's *next* fixture (`corrupted.mp3`) immediately calls
`decodeWaveform()` again, which queues on the **same single thread**, behind
the still-running, already-abandoned 2-hour decode. It cannot start — not
"slow", literally not running yet — until that decode finishes, whatever remains
of its 100-160s. From the user's seat this reads as one continuous, unexplained
stall well past the point any individual file should reasonably take, which
matches "still going, idk when" exactly.

This is a **general bug, not specific to the 2-hour fixture**: it fires
whenever a full decode takes longer than `FULL_TIMEOUT_MS` for *any* reason
(a slow device, a large file, a busy CPU) and something else asks for a decode
afterward — including the app's normal per-file usage, not just this stress test.
It was Suspect 2 in the original research, now confirmed concretely rather than
inferred, and it is a more serious bug than "the queue is long": **a single
timeout, on a single file, permanently wedges every decode behind it until the
abandoned work finishes on its own.**

## Fixed (2026-09-21)

Both directions, implemented together:

- **`RNWaveformModule.kt`**: `getWaveform` now tracks its `Future` per
  `(path, quick, count)` in a `ConcurrentHashMap`. A new `cancelWaveform`
  method looks it up and calls `.cancel(true)`. This works end-to-end because
  `AudioWaveform.read()` already blocks on `threads.forEach { it.join() }` and
  forwards an interrupt to every segment thread on `InterruptedException` —
  code that existed but nothing previously triggered. `waveformExecutor`
  changed from `newSingleThreadExecutor()` to `newFixedThreadPool(2)`, so a
  decode that *hasn't* timed out doesn't fully block a second one either.
- **`decode.ts`**: `decodeWaveform()` now tracks which branch of
  `Promise.race` actually won. Only when the timeout wins does it call
  `native.cancelWaveform?.(path, bins, quick)` (optional-chained and
  try/caught, so an older native build without the method degrades to the old
  behavior rather than throwing). A rejection from the native call itself
  (bad file, etc.) does not trigger cancellation — there is nothing left
  running to cancel.

Verified: `npx jest` — 33/33 (31 existing + 2 new: cancel fires on a timeout,
does not fire on an ordinary rejection). `npx tsc --noEmit` clean. Kotlin: a
forced, non-cached `:react-native-waveform-view:compileDebugKotlin` — see the
build log for pass/fail before this is relied on.

Not yet verified: an actual end-to-end repro (start a decode long enough to
hit `FULL_TIMEOUT_MS`, confirm a second file decodes immediately afterward
instead of queuing) — needs Metro running against the example app. The fix's
individual halves are each proven (Future cancellation is standard, documented
JVM behavior; the executor pool change is a one-line type swap), but the full
chain hasn't been watched happen live.

---

# CONFIRMED IN THE REAL APP (2026-09-21, post-fix)

User-reported numbers from the rebuilt example app (both Android fixes
applied; iOS built and run for the first time this session):

| File | Android before | Android after | iOS |
|---|---|---|---|
| 3 min | 4.24s | 1.56s | 0.47s |
| 23 min | 33.91s | 8.16s | 1.23s |
| 2 hr | did not finish (blocked past the 120s timeout) | 33.16s | 15.83s |

**The headline result: the 2-hour file completes.** At 33.16s it stays well
under the 120s timeout, so this run mainly exercises the segment-cap fix (2
segments -> 4), not the cancellation path — cancellation remains the safety
net for whatever still exceeds 120s (a slower device, a longer file, a busier
CPU), which this file no longer does.

**Caveat on my own numbers:** this in-app 33.16s is ~3x faster than the
102.6s I measured for the same file with the standalone harness. The likely
explanation is host CPU contention during that benchmark — I had concurrent
Gradle/Xcode builds running on the same machine, and the emulator shares host
CPU. Not confirmed, flagged rather than asserted.

**Remaining gap, not a bug:** Android is still slower than iOS (3.3x / 6.6x /
2.1x on 3min / 23min / 2hr — noisy, one sample each). This is the IPC-vs-in-
process architecture difference established earlier (Suspect/Fact 3 in the
original research), not something the segment-cap or cancellation fixes were
meant to close. Closing it further means the bigger, previously-deferred
options: in-process AAC/Opus decoders (Android 17+) or bundling a C decoder
(minimp3/dr_wav/etc.) so both platforms share one decode path. Worth doing
only as a deliberate scope decision, not a bug fix.

---

# DEEP DIVE: closing the remaining Android-vs-iOS gap (2026-09-21)

With the two bugs fixed, the gap is architectural, not broken: Android's
`MediaCodec` round-trips every buffer through a separate sandboxed process;
iOS's `AVAudioFile` decodes in the calling process. This section researches
what it would actually take to close that gap, and whether it's worth doing.

## Confirmed: it's IPC, not compute

> "Codecs are run in their own, sandboxed codec process that communicate with
> other media and app processes using Binder... Every audio input frame
> queued to the decoder and every decoded PCM audio buffer returned requires
> cross-process Binder IPC serialization." — [Android Developers, in-process
> codecs](https://developer.android.com/media/platform/in-process-codecs)

This matches our own measurement exactly (a single decode thread: 6256ms
wall, 912ms CPU — 85% idle, waiting on the codec process).

## Dead end, checked so it doesn't get suggested later: NDK `AMediaCodec`

Sounds like an obvious fix ("drop the JNI/Java overhead, go native"). It
isn't one: `AMediaCodec` uses the **same AIDL/Binder IPC path** to the same
sandboxed codec process as the Java `MediaCodec` API. It removes JNI
marshaling between Java and native code, not the cross-process hop that
actually costs the time. Not worth doing for this problem.

## Option A: Android's own in-process decoders (opt-in today)

`c2.android.inproc.aac.decoder` and `c2.android.inproc.opus.decoder` run in
the app's own process — memory-safe (Rust for AAC, LFI-sandboxed C for Opus),
~40% lower latency per Google's own numbers, opt-in via
`MediaCodec.createByCodecName()` with a fallback to the normal decoder name.

- **Only AAC and Opus. No MP3, and none announced.** Our worst-case fixture
  (the 2-hour file) is MP3 — this wouldn't touch it. It would help the very
  common case of `.m4a`/AAC voice recordings, for free, today, on Android 17+.
- Android is "actively preparing to transition these to become the system
  default... starting with Opus LFI and AAC Rust in Android 18" — so this
  may arrive with no code change at all, later, for everyone. Low cost,
  narrow win, real but partial.

## Option B: bundle decoders, skip the platform codec on both OSes

Decode MP3/AAC/WAV/FLAC/Opus/Vorbis in bundled C, in-process, on both
platforms — the same code path iOS and Android both, closing not just the
speed gap but the byte-for-byte parity gap from Plan.md Phase 2.

**Licensing — checked properly, not assumed:**

| Format | Library | License | Patent status |
|---|---|---|---|
| MP3 | [minimp3](https://github.com/lieff/minimp3) | CC0 (public domain) | **Expired globally in 2017** — Fraunhofer itself ended its MP3 licensing program that year |
| AAC-LC | [fdk-aac-free](https://fedoraproject.org/wiki/Licensing/FDK-AAC) | Permissive, patent-encumbered profiles stripped | AAC-LC's MPEG-2-era patents expired; shipped by **Fedora and Arch since 2017** for exactly this reason. HE-AAC/xHE-AAC (not needed — voice recordings are AAC-LC) stay patent-encumbered and are excluded from this build. |
| Opus | libopus (reference) | BSD 3-clause | Royalty-free by IETF design (RFC 6716) — no patent question at all |
| WAV | [dr_wav](https://github.com/mackron/dr_libs) | Public domain / MIT-0 | None (uncompressed) |
| FLAC | [dr_flac](https://github.com/mackron/dr_libs) | Public domain / MIT-0 | None |
| Vorbis | [stb_vorbis](https://github.com/nothings/stb) | Public domain | None |

Every format we'd realistically need is clean. The naive worry ("MP3/AAC are
patent minefields") is out of date by nearly a decade.

**Performance — checked, not assumed:**

minimp3's own benchmark (i7-6700K) reports decode cost in "MHz required for
real-time" — e.g. 1.5-2.8 MHz to decode 1 second of audio in 1 second. On any
mobile core running at 1.5-3+ GHz, that's **roughly 500-2000x real time** —
comfortably faster than either platform's current numbers (Android 28-106x
measured; iOS's implied ~450-1266x from the parity numbers). Compiled size:
**~30KB (20KB compressed)** per the library's own README — tiny. No FDK-AAC
decode benchmark was findable directly, but the mechanism is the same as
MP3's: Google's own 40% number for their in-process AAC decoder implies the
codec's own compute is already a small fraction of total time once IPC is
gone — consistent with our 85%-idle measurement.

**Cost — this is the real trade-off, and it cuts against the library's own goals:**

- Two native toolchains to maintain (NDK/CMake on Android, an Xcode target on
  iOS) instead of the platform SDKs everyone already ships.
- Real binary size: minimp3 ~30KB, but dr_flac's source alone is 520KB
  (compiles much smaller, unmeasured) and fdk-aac-free is a bigger codec with
  internal tables — a rough estimate is low-hundreds-of-KB to low single-digit
  MB once built for multiple architectures (arm64 + x86_64 + armv7). That is
  **in direct tension with Plan.md's own budget** — "zero runtime
  dependencies... ≤60KB packed" is the whole pitch of this library versus the
  alternatives.
- No existing React Native library does this (checked — Simform, waveform-
  player, and everything else in the comparison table all use the platform
  codec). That's either a genuine gap to fill, or a sign it isn't worth the
  cost for this problem. Given the numbers below, I think it's the latter,
  for now.

## Recommendation: don't build this yet

Before the two bug fixes, the 2-hour file didn't finish at all. After them,
it's **33s vs iOS's 15.83s — a 2.1x gap**, and the worst ratio anywhere in the
data is 6.6x on one file, on an emulator, from a single sample each. The
bug fixes closed the part of this that was actually broken. What's left is a
real but modest architecture difference, not a user-facing failure.

Bundling native decoders would likely close it, plausibly beating both
platforms' current numbers — but it costs real size and two build systems, in
a library whose whole positioning is "lightweight, zero deps." That's a
deliberate scope decision, not a bug fix, and it shouldn't be made by default.

**If this gets revisited:** ship it as a separate, opt-in package (e.g.
`rn-waveform-fast-decode`) that swaps the decode path, not a change to the
core library — keeps the "zero runtime deps" claim true for everyone who
doesn't need it. Trigger conditions worth watching for before spending the
time: real (non-emulator) device numbers coming back worse than what's
measured here, or actual user complaints post-launch rather than a stress-
test fixture.
