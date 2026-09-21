import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withDecay,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

const AnimatedInput = Animated.createAnimatedComponent(TextInput);

/**
 * Bars are drawn in fixed chunks, never the whole track. Each chunk is ONE
 * svg path rather than a view per bar: the scroll offset changes every frame,
 * and with hundreds of child views that per-frame update measured ~27ms —
 * dropping frames. A handful of paths keeps it cheap.
 */
const CHUNK = 64;
/**
 * Both colour layers draw RADIUS chunks either side of `center` (~5 screens
 * each way), and `center` only moves once the playhead is RECENTER chunks
 * away from it. Scrolling therefore never waits on the JS thread: the swap
 * happens in the background with screens of bars still in hand.
 */
const RADIUS = 6;
const RECENTER = 2;
/** After a scrub, player reports from before the seek are ignored this long at most. */
const SEEK_SETTLE_MS = 3000;
/**
 * While playing, the view runs on its own clock. Player reports arrive every
 * ~100ms with ~60ms granularity and occasional ~300ms-late outliers, so a
 * report never moves the view directly: a fraction of the difference is
 * queued and bled in over ~CORRECTION_MS, which shows up as a tiny speed
 * change instead of a jump. Only a gap this large — a real seek — snaps.
 */
const SNAP_MS = 1000;
const NUDGE = 0.2;
const CORRECTION_MS = 300;

export type WaveformGradientStop = { level: number; color: string };

export type WaveformGradientConfig = {
  /** Color for flatter / quiet audio sections (levels near 0.0). Defaults to #EAB308 (yellow). */
  flat?: string;
  /** Color for normal speech / mid amplitude (levels around 0.3 - 0.6). Defaults to #22C55E (green). */
  normal?: string;
  /** Color for high intensity / peak voice (levels above 0.7). Defaults to #EF4444 (red). */
  peak?: string;
  /** Custom explicit stops mapped to 0..1 amplitude levels. */
  stops?: WaveformGradientStop[];
};

export type WaveformGradient = boolean | WaveformGradientConfig | WaveformGradientStop[] | string[];

export const DEFAULT_WAVEFORM_GRADIENT: WaveformGradientConfig = {
  flat: '#EAB308',   // Flatter frequency -> Yellow
  normal: '#22C55E', // Normal voice bars -> Green
  peak: '#EF4444',   // High pitch/loud voice -> Red
};

function parseColor(color: string): [number, number, number, number] {
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        1,
      ];
    }
    if (hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        parseInt(hex.slice(6, 8), 16) / 255,
      ];
    }
  } else if (color.startsWith('rgb')) {
    const match = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (match) {
      return [
        parseFloat(match[1]),
        parseFloat(match[2]),
        parseFloat(match[3]),
        match[4] !== undefined ? parseFloat(match[4]) : 1,
      ];
    }
  }
  return [255, 255, 255, 1];
}

function interpolateColor(colorA: string, colorB: string, t: number): string {
  const [r1, g1, b1, a1] = parseColor(colorA);
  const [r2, g2, b2, a2] = parseColor(colorB);
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(r1 + (r2 - r1) * clamped);
  const g = Math.round(g1 + (g2 - g1) * clamped);
  const b = Math.round(b1 + (b2 - b1) * clamped);
  const a = a1 + (a2 - a1) * clamped;
  if (a >= 0.999) {
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

export function resolveGradientStops(gradient: WaveformGradient | undefined): WaveformGradientStop[] | null {
  if (!gradient) return null;
  if (gradient === true) {
    return [
      { level: 0.0, color: DEFAULT_WAVEFORM_GRADIENT.flat! },
      { level: 0.4, color: DEFAULT_WAVEFORM_GRADIENT.normal! },
      { level: 0.8, color: DEFAULT_WAVEFORM_GRADIENT.peak! },
    ];
  }
  if (Array.isArray(gradient)) {
    if (gradient.length === 0) return null;
    if (typeof gradient[0] === 'string') {
      const colors = gradient as string[];
      if (colors.length === 1) return [{ level: 0.0, color: colors[0] }, { level: 1.0, color: colors[0] }];
      return colors.map((color, idx) => ({
        level: idx / (colors.length - 1),
        color,
      }));
    }
    return [...(gradient as WaveformGradientStop[])].sort((a, b) => a.level - b.level);
  }
  if (typeof gradient === 'object') {
    if (gradient.stops && gradient.stops.length > 0) {
      return [...gradient.stops].sort((a, b) => a.level - b.level);
    }
    return [
      { level: 0.0, color: gradient.flat ?? DEFAULT_WAVEFORM_GRADIENT.flat! },
      { level: 0.4, color: gradient.normal ?? DEFAULT_WAVEFORM_GRADIENT.normal! },
      { level: 0.8, color: gradient.peak ?? DEFAULT_WAVEFORM_GRADIENT.peak! },
    ];
  }
  return null;
}

/**
 * Groups adjacent `detail` values so each bar covers `msPerBar` instead of
 * `detailMs`. `msPerBar` can't go finer than the decoded resolution — there's
 * no real data to show — so it's clamped up to `detailMs`, which is also the
 * default: omitted, this is a no-op and returns `detail`/`detailMs` as-is.
 */
export function resampleDetail(
  detail: readonly number[],
  detailMs: number,
  msPerBar?: number,
): { detail: readonly number[]; detailMs: number } {
  if (!msPerBar || msPerBar <= detailMs || detail.length === 0) return { detail, detailMs };
  const groupSize = Math.round(msPerBar / detailMs);
  if (groupSize <= 1) return { detail, detailMs };
  const out: number[] = [];
  for (let i = 0; i < detail.length; i += groupSize) {
    const end = Math.min(detail.length, i + groupSize);
    let sum = 0;
    for (let j = i; j < end; j++) sum += detail[j];
    out.push(sum / (end - i));
  }
  return { detail: out, detailMs: groupSize * detailMs };
}

export function sampleGradientColor(stops: WaveformGradientStop[], level: number): string {
  if (stops.length === 0) return '#FFFFFF';
  const clamped = Math.max(0, Math.min(1, level));
  if (clamped <= stops[0].level) return stops[0].color;
  if (clamped >= stops[stops.length - 1].level) return stops[stops.length - 1].color;
  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i];
    const s2 = stops[i + 1];
    if (clamped >= s1.level && clamped <= s2.level) {
      const span = s2.level - s1.level;
      const t = span <= 0 ? 0 : (clamped - s1.level) / span;
      return interpolateColor(s1.color, s2.color, t);
    }
  }
  return stops[stops.length - 1].color;
}

export type WaveformHandlePreset = 'dot' | 'ring' | 'pill' | 'bar' | 'none';

/** A preset's box, sized off `radius`; centered by its parent slot regardless of its own aspect ratio. */
function presetHandleBox(preset: WaveformHandlePreset, radius: number, color: string): ViewStyle | null {
  switch (preset) {
    case 'none':
      return null;
    case 'ring':
      return { width: radius * 2, height: radius * 2, borderRadius: radius, borderWidth: 2, borderColor: color };
    case 'pill': {
      const w = radius * 1.1;
      const h = radius * 2.6;
      return { width: w, height: h, borderRadius: Math.min(w, h) / 2, backgroundColor: color };
    }
    case 'bar': {
      const w = radius * 3;
      const h = Math.max(3, radius * 0.7);
      return { width: w, height: h, borderRadius: h / 2, backgroundColor: color };
    }
    case 'dot':
    default:
      return { width: radius * 2, height: radius * 2, borderRadius: radius, backgroundColor: color };
  }
}

export type WaveformPlayheadPreset = 'line' | 'thick' | 'dashed' | 'glow' | 'none';

/** A preset's own box; centered in its slot regardless of how wide it renders. */
function presetPlayheadBox(preset: WaveformPlayheadPreset, width: number, color: string, height: number): ViewStyle | null {
  switch (preset) {
    case 'none':
      return null;
    case 'thick':
      return { width: width * 2, height, backgroundColor: color, borderRadius: width };
    case 'dashed':
      // RN's border-style trick: a zero-width box with a dashed left border
      // draws a dashed vertical line — there's no dashed-fill primitive.
      return { width: 0, height, borderLeftWidth: width, borderStyle: 'dashed', borderColor: color };
    case 'glow':
      return {
        width, height, backgroundColor: color, borderRadius: width / 2,
        shadowColor: color, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 6,
      };
    case 'line':
    default:
      return { width, height, backgroundColor: color, borderRadius: width / 2 };
  }
}

export type WaveformProps = {
  /** Normalized levels (0..1), one per `detailMs`. See `useWaveform().detail`. */
  detail: readonly number[];
  /** Milliseconds each level covers. */
  detailMs?: number;
  /**
   * Milliseconds a single drawn bar should represent. Adjacent `detail`
   * values are averaged together to make coarser bars. Can't go finer than
   * `detailMs` — there's no decoded data between slices to show — so smaller
   * values are clamped up to it. Defaults to `detailMs`: one bar per decoded
   * slice, today's default resolution.
   */
  msPerBar?: number;
  durationMs: number;
  /** Current playback position as 0..1. */
  progress: number;
  isPlaying?: boolean;
  /** Playback speed, so the view keeps up at 1.5x/2x. */
  playbackRate?: number;
  height?: number;
  /** True while your player is seeking, so reports of the old position are ignored. */
  isSeeking?: boolean;
  onSeekStart?: () => void;
  /** Called once when the user lets go, with the target position as 0..1. */
  onSeekEnd?: (progress: number) => void;
  style?: StyleProp<ViewStyle>;
  /** Bars behind the playhead. */
  playedColor?: string;
  /**
   * Gradient for played bars across the horizontal timeline.
   * Can be true for default colors (yellow -> green -> red),
   * an object with `{ flat, normal, peak }`, or an array of stops/colors.
   */
  playedGradient?: WaveformGradient;
  /** Bars ahead of the playhead. */
  upcomingColor?: string;
  /** Gradient for upcoming bars across the horizontal timeline. */
  upcomingGradient?: WaveformGradient;
  playheadColor?: string;
  /** Playhead line thickness in dp. Defaults to `2`. */
  playheadWidth?: number;
  /** Built-in playhead line style. Ignored if `renderPlayhead` is set. Defaults to `'line'`. */
  playheadPreset?: WaveformPlayheadPreset;
  /**
   * Renders your own playhead line instead of a preset. Centered in a
   * `playheadWidth`-wide slot spanning the full height; return something
   * wider or narrower and it still centers correctly.
   */
  renderPlayhead?: (info: { color: string; width: number; height: number }) => React.ReactNode;
  /** Draggable-looking knob on the playhead. Defaults to `true`. */
  showHandle?: boolean;
  /** Handle colour. Defaults to `playheadColor`. */
  handleColor?: string;
  /** Handle size in dp — also the size of the slot `renderHandle` centers in. */
  handleRadius?: number;
  /** Built-in handle shape. Ignored if `renderHandle` is set. Defaults to `'dot'`. */
  handlePreset?: WaveformHandlePreset;
  /**
   * Renders your own handle instead of a preset — an Image, Lottie, icon,
   * anything. Centered in a `handleRadius`-sized slot at the playhead; return
   * something bigger or smaller and it still centers correctly. `dragging` is
   * live React state (not a worklet value), so it's safe to use directly in
   * your JSX/styles.
   */
  renderHandle?: (info: { color: string; radius: number; dragging: boolean }) => React.ReactNode;
  /**
   * Colour the edges fade into — set this to the background behind the view.
   * Omit for no fade.
   */
  fadeColor?: string;
  fadeWidth?: number;
  barWidth?: number;
  barGap?: number;
  /** Time bubble shown under the playhead while scrubbing. */
  showTimestamp?: boolean;
  timestampStyle?: StyleProp<TextStyle>;
  timestampContainerStyle?: StyleProp<ViewStyle>;
};

/** Chunk indices in [from, to] that exist for a track of `length` bars. */
function chunkRange(from: number, to: number, length: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i <= to && i * CHUNK < length; i++) out.push(i);
  return out;
}

type ChunkProps = {
  index: number;
  detail: readonly number[];
  color: string;
  gradientStops: WaveformGradientStop[] | null;
  idPrefix: string;
  height: number;
  barWidth: number;
  pitch: number;
};

const Chunk = memo(({ index, detail, color, gradientStops, idPrefix, height, barWidth, pitch }: ChunkProps) => {
  const start = index * CHUNK;
  const end = Math.min(detail.length, start + CHUNK);
  if (start < 0 || start >= end) return null;
  // Round caps extend each line by half the stroke width at both ends.
  const cap = barWidth / 2;
  const chunkWidth = CHUNK * pitch;
  const gradientId = `grad_${idPrefix}_${index}`;
  let d = '';
  const stops: React.ReactElement[] = [];

  let firstColor = '';
  let lastColor = '';

  for (let i = start; i < end; i++) {
    const barHeight = barWidth + (height - barWidth * 2 - 1) * detail[i];
    const top = (height - barHeight) / 2 + cap;
    const bottom = Math.max(top, top + barHeight - barWidth);
    const x = (i - start) * pitch + cap;
    d += `M${x.toFixed(1)} ${top.toFixed(1)}V${bottom.toFixed(1)}`;

    if (gradientStops) {
      const barColor = sampleGradientColor(gradientStops, detail[i]);
      if (i === start) {
        firstColor = barColor;
        stops.push(<Stop key="start" offset="0%" stopColor={firstColor} />);
      }
      lastColor = barColor;
      const offsetPct = Math.min(100, Math.max(0, (x / chunkWidth) * 100)).toFixed(2) + '%';
      stops.push(<Stop key={i} offset={offsetPct} stopColor={barColor} />);
    }
  }

  if (gradientStops && lastColor) {
    stops.push(<Stop key="end" offset="100%" stopColor={lastColor} />);
  }

  return (
    <Svg style={[styles.chunk, { left: start * pitch }]} width={chunkWidth} height={height}>
      {gradientStops && (
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2={chunkWidth} y2="0" gradientUnits="userSpaceOnUse">
            {stops}
          </LinearGradient>
        </Defs>
      )}
      <Path
        d={d}
        stroke={gradientStops ? `url(#${gradientId})` : color}
        strokeWidth={barWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
});

/**
 * A close-up waveform that scrolls under a fixed playhead, one bar per
 * `detailMs`, so bars follow individual words and pauses however long the
 * audio is. Played audio (left of the playhead) is drawn in the accent
 * colour, the rest in grey — two layers split at the playhead, so playback
 * only ever translates them on the UI thread and never recolours bars.
 *
 * Drag to scrub, fling to glide; the audio is seeked once, on release.
 */
export default function Waveform({
  detail: rawDetail,
  detailMs: rawDetailMs = 100,
  msPerBar,
  durationMs,
  progress,
  isPlaying = false,
  playbackRate = 1,
  height = 64,
  isSeeking = false,
  onSeekStart,
  onSeekEnd,
  style,
  playedColor = '#A855F7',
  playedGradient,
  upcomingColor = '#E5E7EB',
  upcomingGradient,
  playheadColor = '#FFFFFF',
  playheadWidth = 2,
  playheadPreset = 'line',
  renderPlayhead,
  showHandle = true,
  handleColor = playheadColor,
  handleRadius = 5,
  handlePreset = 'dot',
  renderHandle,
  fadeColor,
  fadeWidth = 64,
  barWidth = 3,
  barGap = 2,
  showTimestamp = true,
  timestampStyle,
  timestampContainerStyle,
}: WaveformProps) {
  // Grouped into coarser bars first (a no-op unless msPerBar is set), then
  // every position/scroll/gesture calculation below works in bar-time the
  // same way it always has — they only ever see `detailMs`, never `msPerBar`.
  const { detail, detailMs } = useMemo(
    () => resampleDetail(rawDetail, rawDetailMs, msPerBar),
    [rawDetail, rawDetailMs, msPerBar],
  );
  const pitch = barWidth + barGap;
  const [width, setWidth] = useState(0);
  const half = width / 2;
  const positionMs = useSharedValue(progress * durationMs);
  const dragStartMs = useSharedValue(0);
  const dragging = useSharedValue(false);
  const initialChunk = Math.floor((progress * durationMs) / detailMs / CHUNK);
  const [center, setCenter] = useState(initialChunk);
  const shownCenter = useSharedValue(initialChunk);

  // Sync with the audio the way media players do: on every frame (UI thread),
  // position = last anchor + elapsed time x playback rate. Chasing each
  // player report with a short animation lags behind and then leaps forward,
  // because the JS thread reads a stale copy of an animating value.
  const reportedMs = useSharedValue(progress * durationMs);
  const reportSeq = useSharedValue(0);
  const seenSeq = useSharedValue(0);
  const anchorMs = useSharedValue(progress * durationMs);
  const anchorAt = useSharedValue(-1);
  const playing = useSharedValue(isPlaying);
  const rate = useSharedValue(playbackRate);
  const reanchor = useSharedValue(true);
  const pendingCorrection = useSharedValue(0);
  const lastFrameAt = useSharedValue(-1);
  // Set when a scrub ends: until the player reports a position near what's
  // shown, its reports are from before the seek and must not pull us back.
  const awaitingSeek = useSharedValue(false);
  const awaitingSince = useSharedValue(-1);
  const duration = useSharedValue(durationMs);

  useEffect(() => {
    duration.value = durationMs;
  }, [durationMs, duration]);

  useEffect(() => {
    // Mid-seek a player can still report the old position; wait for it.
    if (isSeeking) return;
    reportedMs.value = progress * durationMs;
    reportSeq.value += 1;
  }, [progress, durationMs, isSeeking, reportedMs, reportSeq]);

  useEffect(() => {
    playing.value = isPlaying;
    rate.value = playbackRate;
    reanchor.value = true;
  }, [isPlaying, playbackRate, playing, rate, reanchor]);

  useFrameCallback(frame => {
    const now = frame.timestamp;
    const frameMs = lastFrameAt.value < 0 ? 16 : now - lastFrameAt.value;
    lastFrameAt.value = now;
    if (dragging.value) {
      // Reports during a scrub describe the old position; drop them.
      seenSeq.value = reportSeq.value;
      return;
    }
    const current = () =>
      playing.value && anchorAt.value >= 0
        ? anchorMs.value + (now - anchorAt.value) * rate.value
        : anchorMs.value;
    if (reanchor.value) {
      // Play/pause/speed change or end of a drag: continue from what's shown.
      anchorMs.value = anchorAt.value < 0 ? reportedMs.value : positionMs.value;
      anchorAt.value = now;
      pendingCorrection.value = 0;
      reanchor.value = false;
      if (awaitingSeek.value && awaitingSince.value < 0) awaitingSince.value = now;
    }
    if (reportSeq.value !== seenSeq.value) {
      seenSeq.value = reportSeq.value;
      const offset = reportedMs.value - current();
      if (awaitingSeek.value) {
        if (Math.abs(offset) > SNAP_MS && now - awaitingSince.value < SEEK_SETTLE_MS) {
          // Stale: the seek hasn't landed yet. Keep showing where the user let go.
          positionMs.value = Math.max(0, Math.min(duration.value, current()));
          return;
        }
        awaitingSeek.value = false;
      }
      if (!playing.value || Math.abs(offset) > SNAP_MS) {
        anchorMs.value = reportedMs.value;
        anchorAt.value = now;
        pendingCorrection.value = 0;
      } else {
        pendingCorrection.value += offset * NUDGE;
      }
    }
    if (pendingCorrection.value !== 0) {
      const step = pendingCorrection.value * Math.min(1, frameMs / CORRECTION_MS);
      anchorMs.value += step;
      pendingCorrection.value -= step;
    }
    positionMs.value = Math.max(0, Math.min(duration.value, current()));
  });

  // Re-render only once the playhead has moved RECENTER chunks of audio.
  useAnimatedReaction(
    () => Math.floor(positionMs.value / detailMs / CHUNK),
    next => {
      if (Math.abs(next - shownCenter.value) >= RECENTER) {
        shownCenter.value = next;
        runOnJS(setCenter)(next);
      }
    },
    [detailMs],
  );

  const trackStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -(positionMs.value / detailMs) * pitch }],
  }));

  // Callbacks change on every parent render (~10x/s while playing); read them
  // through a ref so the gesture — and its worklets — are built only once.
  const callbacks = useRef({ onSeekStart, onSeekEnd, durationMs });
  callbacks.current = { onSeekStart, onSeekEnd, durationMs };
  // Plain React state, for renderHandle — a worklet's `dragging` shared value
  // isn't readable from JS render. setIsDragging is stable across renders, so
  // it's safe to call even from an older, memoized gesture closure below.
  const [isDragging, setIsDragging] = useState(false);
  const startSeek = () => {
    setIsDragging(true);
    callbacks.current.onSeekStart?.();
  };
  const finishSeek = (ms: number) => {
    setIsDragging(false);
    const { onSeekEnd: end, durationMs: total } = callbacks.current;
    if (end && total > 0) end(Math.max(0, Math.min(1, ms / total)));
  };
  const seekEnabled = Boolean(onSeekEnd) && durationMs > 0;

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(seekEnabled)
        .onStart(() => {
          cancelAnimation(positionMs);
          dragging.value = true;
          awaitingSeek.value = false;
          dragStartMs.value = positionMs.value;
          runOnJS(startSeek)();
        })
        .onUpdate(event => {
          const ms = dragStartMs.value - (event.translationX / pitch) * detailMs;
          positionMs.value = Math.max(0, Math.min(duration.value, ms));
        })
        .onEnd(event => {
          positionMs.value = withDecay(
            {
              velocity: -(event.velocityX / pitch) * detailMs,
              clamp: [0, duration.value],
              deceleration: 0.996,
            },
            finished => {
              // A new drag cancelling the glide will seek on its own release.
              if (!finished) return;
              awaitingSeek.value = true;
              awaitingSince.value = -1;
              reanchor.value = true;
              dragging.value = false;
              runOnJS(finishSeek)(positionMs.value);
            },
          );
        })
        .onFinalize((_event, success) => {
          if (success || !dragging.value) return;
          positionMs.value = dragStartMs.value;
          reanchor.value = true;
          dragging.value = false;
          runOnJS(finishSeek)(dragStartMs.value);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seekEnabled, detailMs, pitch],
  );

  const bubble = useAnimatedStyle(() => ({ opacity: dragging.value ? 1 : 0 }));
  const timestamp = useAnimatedProps(() => {
    const seconds = Math.floor(positionMs.value / 1000);
    const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    return { text: label, defaultValue: label };
  });

  // Both layers need bars on both sides: the split point moves with the
  // playhead, so scrubbing back uncovers grey bars behind it and vice versa.
  const chunks = useMemo(() => chunkRange(center - RADIUS, center + RADIUS, detail.length), [center, detail.length]);
  const playedStops = useMemo(() => resolveGradientStops(playedGradient), [playedGradient]);
  const upcomingStops = useMemo(() => resolveGradientStops(upcomingGradient), [upcomingGradient]);

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.container, { height }, style]} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <>
            <View style={[styles.half, { width: half, height }]}>
              <Animated.View style={[styles.track, { left: half, height }, trackStyle]}>
                {chunks.map(i => (
                  <Chunk
                    key={i}
                    index={i}
                    detail={detail}
                    color={playedColor}
                    gradientStops={playedStops}
                    idPrefix="p"
                    height={height}
                    barWidth={barWidth}
                    pitch={pitch}
                  />
                ))}
              </Animated.View>
            </View>
            <View style={[styles.half, { left: half, width: half, height }]}>
              <Animated.View style={[styles.track, styles.trackStart, { height }, trackStyle]}>
                {chunks.map(i => (
                  <Chunk
                    key={i}
                    index={i}
                    detail={detail}
                    color={upcomingColor}
                    gradientStops={upcomingStops}
                    idPrefix="u"
                    height={height}
                    barWidth={barWidth}
                    pitch={pitch}
                  />
                ))}
              </Animated.View>
            </View>
            {fadeColor && (
              <Svg pointerEvents="none" style={styles.fade} width={width} height={height}>
                <Defs>
                  <LinearGradient id="leftFade" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor={fadeColor} stopOpacity="1" />
                    <Stop offset="1" stopColor={fadeColor} stopOpacity="0" />
                  </LinearGradient>
                  <LinearGradient id="rightFade" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor={fadeColor} stopOpacity="0" />
                    <Stop offset="1" stopColor={fadeColor} stopOpacity="1" />
                  </LinearGradient>
                </Defs>
                <Rect x="0" y="0" width={fadeWidth} height={height} fill="url(#leftFade)" />
                <Rect x={Math.max(0, width - fadeWidth)} y="0" width={fadeWidth} height={height} fill="url(#rightFade)" />
              </Svg>
            )}
            <View pointerEvents="none" style={[styles.playheadSlot, { left: half - playheadWidth / 2, width: playheadWidth, height }]}>
              {renderPlayhead
                ? renderPlayhead({ color: playheadColor, width: playheadWidth, height })
                : (() => {
                    const box = presetPlayheadBox(playheadPreset, playheadWidth, playheadColor, height);
                    return box ? <View style={box} /> : null;
                  })()}
            </View>
            {showHandle && (
              <View
                pointerEvents="none"
                style={[
                  styles.handleSlot,
                  { left: half - handleRadius, top: -handleRadius, width: handleRadius * 2, height: handleRadius * 2 },
                ]}
              >
                {renderHandle
                  ? renderHandle({ color: handleColor, radius: handleRadius, dragging: isDragging })
                  : (() => {
                      const box = presetHandleBox(handlePreset, handleRadius, handleColor);
                      return box ? <View style={box} /> : null;
                    })()}
              </View>
            )}
            {showTimestamp && (
              <Animated.View
                pointerEvents="none"
                style={[styles.bubble, { left: half - 32, top: height + 4 }, timestampContainerStyle, bubble]}
              >
                <AnimatedInput
                  editable={false}
                  caretHidden
                  underlineColorAndroid="transparent"
                  animatedProps={timestamp}
                  style={[styles.timestamp, timestampStyle]}
                />
              </Animated.View>
            )}
          </>
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', overflow: 'visible' },
  half: { position: 'absolute', top: 0, overflow: 'hidden' },
  track: { position: 'absolute', top: 0 },
  trackStart: { left: 0 },
  fade: { position: 'absolute', top: 0, left: 0 },
  chunk: { position: 'absolute', top: 0 },
  playheadSlot: { position: 'absolute', top: 0, alignItems: 'center', justifyContent: 'center' },
  handleSlot: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  bubble: { position: 'absolute', width: 64, borderRadius: 16, backgroundColor: '#fff', zIndex: 2 },
  timestamp: { color: '#111', padding: 4, fontSize: 12, textAlign: 'center' },
});
