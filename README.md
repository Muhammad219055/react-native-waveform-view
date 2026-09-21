# react-native-waveform-view

**React Native audio waveform** view with a scrolling waveform scrubber, for Android and iOS.

Also published as [`rn-waveform`](https://www.npmjs.com/package/rn-waveform) — same package, shorter name.

[![npm](https://img.shields.io/npm/v/react-native-waveform-view)](https://www.npmjs.com/package/react-native-waveform-view)
[![downloads](https://img.shields.io/npm/dw/react-native-waveform-view)](https://www.npmjs.com/package/react-native-waveform-view)
[![license](https://img.shields.io/npm/l/react-native-waveform-view)](./LICENSE)

A close-up audio waveform that **scrolls under a fixed playhead**, stays in sync with **your** player, and works on audio of any length — voice notes, podcasts, interviews, lectures.

One bar per 100ms of audio, so bars follow individual words and pauses whether the file is 30 seconds or two hours. Drag to scrub, fling to glide, and the audio seeks once, on release.

```
        played │ upcoming
   ▁▃▅█▇▅▃▁▂▄▆█│▆▄▂▁▃▅▇█▅▃▁▂▄▆█▅▃
               ▲ playhead (fixed)
```

## Why another React Native waveform library?

Most React Native waveform libraries own playback and squeeze the whole file into a few hundred bars. That works for a 20-second voice note; a 40-minute recording becomes a flat line, and you have to abandon the player you already use.

This library does the opposite: **it draws, you play.**

- **Bring your own player.** Works with `react-native-track-player`, `react-native-nitro-sound`, `expo-av`, `react-native-video` or anything else. You pass `progress`, `isPlaying` and `playbackRate`; it calls `onSeekEnd`.
- **Long audio stays readable.** The track scrolls instead of compressing, so detail per second is constant at any duration.
- **Smooth at 60fps while playing.** Position is predicted on the UI thread between your player's position reports, and only a handful of SVG paths move per frame.
- **Precompute once, render instantly.** Decode at import time, store the numbers in your own database, and hand them back — no decoding when the screen opens.
- **Perceptual loudness, not raw peaks.** Levels come from dB-averaged 20ms slices, so a quiet pause reads as a short bar rather than noise.

## Install

```sh
npm install react-native-waveform-view
cd ios && pod install
```

Peer dependencies: `react-native-reanimated`, `react-native-gesture-handler`, `react-native-svg`.

A native rebuild is required (the decoders are native). For the smoothest scrolling, enable Reanimated's synchronous UI props in **your app's** `package.json`:

```json
"reanimated": {
  "staticFeatureFlags": {
    "ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS": true,
    "IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS": true
  }
}
```

## Usage

```tsx
import { Waveform, useWaveform } from 'react-native-waveform-view';

function Player({ path, player }) {
  const { detail, detailMs, loading } = useWaveform(path);

  if (loading || !detail) return <Placeholder />;

  return (
    <Waveform
      detail={detail}
      detailMs={detailMs}
      durationMs={player.durationMs}
      progress={player.positionMs / player.durationMs}
      isPlaying={player.isPlaying}
      playbackRate={player.rate}
      isSeeking={player.isSeeking}
      onSeekStart={player.beginSeek}
      onSeekEnd={p => player.seekTo(p * player.durationMs)}
      playedColor="#A855F7"
      upcomingColor="#E5E7EB"
      fadeColor="#131D6A"
    />
  );
}
```

### Decode once, store it yourself

```ts
import { decodeWaveform, cacheWaveform } from 'react-native-waveform-view';

// On import/upload:
const waveform = await decodeWaveform(path);      // { overview, detail, detailMs }
await db.save(path, waveform);                    // plain arrays of numbers

// On the next launch, before rendering:
cacheWaveform(path, await db.load(path));         // useWaveform() returns instantly
```

`decodeWaveform(path, { quick: true })` returns a sampled overview in about a second for long files — show it while the full decode runs. `useWaveform()` does this for you.

## API

### `<Waveform />`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `detail` | `number[]` | required | Normalized levels (0..1), one per `detailMs` |
| `detailMs` | `number` | `100` | Milliseconds per level |
| `durationMs` | `number` | required | |
| `progress` | `number` | required | Playback position as 0..1 |
| `isPlaying` | `boolean` | `false` | Drives the internal clock |
| `playbackRate` | `number` | `1` | Keeps 1.5x/2x in sync |
| `isSeeking` | `boolean` | `false` | True while your player seeks |
| `onSeekStart` | `() => void` | | Fires when a drag begins |
| `onSeekEnd` | `(progress: number) => void` | | Fires once, on release |
| `height` | `number` | `64` | |
| `playedColor` / `upcomingColor` / `playheadColor` | `string` | | |
| `fadeColor` | `string` | | Background colour the edges fade into; omit for no fade |
| `fadeWidth` | `number` | `64` | |
| `barWidth` / `barGap` | `number` | `3` / `2` | |
| `showTimestamp` | `boolean` | `true` | Bubble under the playhead while scrubbing |

Omit `onSeekEnd` to make the waveform display-only.

### Functions

- `useWaveform(path, { quickFirst?, bins?, stored? })` → `{ samples, detail, detailMs, waveform, loading, failed }`
- `decodeWaveform(path, { quick?, bins? })` → `Promise<WaveformData>`
- `getDurationSeconds(path)` → `Promise<number>`
- `cacheWaveform` / `getCachedWaveform` / `clearWaveformCache`
- `normalizeLoudness(values)` — maps stored 0..1 loudness onto a 40dB display range

`samples` is a whole-file overview (64 bars by default) if you also want a fixed-width waveform.

## How the sync works

A player reports its position roughly ten times a second, and each report is already late by the time React re-renders. Following those reports directly produces visible stutter.

Instead, the view keeps its own clock on the UI thread: `position = anchor + elapsed × rate`, evaluated every frame. Each report is compared to that clock and a fraction of the difference is bled in over ~300ms, which reads as a tiny speed change rather than a jump. Only a gap over a second — a real seek — snaps. After a scrub, reports from before the seek are ignored until the player catches up.

## Rendering

Bars are drawn as **one SVG path per 64 bars**, not a view per bar: with hundreds of child views, the per-frame transform update measured ~27ms and dropped frames. Both colour layers draw about five screens either side of the playhead and only re-centre after the playhead has moved a long way, so scrolling and scrubbing never wait on the JS thread.

## Limitations

- **Local files only.** No remote URL streaming; download first.
- **No playback and no recording.** This is a view plus a decoder. Live mic waveforms are out of scope.
- **Legacy native module.** It works under both the old and new architecture (via the interop layer), but is not yet a codegen TurboModule.
- **iOS is unverified.** The iOS decoder is written but has not been compiled or run yet. Android is tested on device.
- **No web support.**

## FAQ

### How do I show an audio waveform in React Native?

Install `react-native-waveform-view`, decode the file once with `decodeWaveform(path)` or `useWaveform(path)`, and render `<Waveform />` with your player's position. The decoding is native (MediaCodec on Android, AVAudioFile on iOS); no JavaScript audio parsing.

### How do I add a waveform to react-native-track-player?

This library does not play audio, so it pairs with `react-native-track-player` directly: pass `progress` from `useProgress()`, `isPlaying` from `usePlaybackState()`, and call `TrackPlayer.seekTo()` from `onSeekEnd`. The same applies to `react-native-nitro-sound`, `expo-av`, `react-native-video` or a custom native player.

### How do I extract waveform data from an audio file in React Native?

`await decodeWaveform(path)` returns `{ overview, detail, detailMs }` — plain arrays of numbers on 0..1. Store them in your own database and pass them back later, so screens open with no decoding and no spinner.

### Why is my waveform flat for long audio?

Because most waveform views squeeze the whole file into a few hundred bars, and a 40-minute recording averages out to a straight line. This library keeps a constant 100ms per bar and scrolls instead, so detail per second never changes with duration.

### Does it work with the New Architecture (Fabric)?

Yes. The view is plain React Native plus Reanimated and `react-native-svg`; the native decoder is a legacy bridge module that runs under the new architecture through the interop layer.

### Does it work with Expo?

Untested. It needs a native build, so Expo Go is out; a development build with prebuild should work, but nobody has verified it yet.

## Alternatives

| Library | Owns playback | Long audio | Data you can store |
| --- | --- | --- | --- |
| **react-native-waveform-view** | No — use any player | Scrolls, 100ms per bar | Yes |
| [@simform_solutions/react-native-audio-waveform](https://github.com/SimformSolutionsPvtLtd/react-native-audio-waveform) | Yes | Whole file compressed to N bars | Not documented |
| [react-native-waveform-player](https://github.com/maitrungduc1410/react-native-waveform-player) | Yes | Fixed waveform, moving playhead | Yes, via `samples` |
| [react-native-audiowaveform](https://github.com/juananime/react-native-audiowaveform) | Yes | Unmaintained since 2022 | No |

## License

MIT
