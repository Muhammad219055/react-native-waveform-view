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

export type WaveformProps = {
  /** Normalized levels (0..1), one per `detailMs`. See `useWaveform().detail`. */
  detail: readonly number[];
  /** Milliseconds each level covers. */
  detailMs?: number;
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
  /** Bars ahead of the playhead. */
  upcomingColor?: string;
  playheadColor?: string;
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
  height: number;
  barWidth: number;
  pitch: number;
};

const Chunk = memo(({ index, detail, color, height, barWidth, pitch }: ChunkProps) => {
  const start = index * CHUNK;
  const end = Math.min(detail.length, start + CHUNK);
  if (start < 0 || start >= end) return null;
  // Round caps extend each line by half the stroke width at both ends.
  const cap = barWidth / 2;
  let d = '';
  for (let i = start; i < end; i++) {
    const barHeight = barWidth + (height - barWidth * 2 - 1) * detail[i];
    const top = (height - barHeight) / 2 + cap;
    const bottom = Math.max(top, top + barHeight - barWidth);
    const x = (i - start) * pitch + cap;
    d += `M${x.toFixed(1)} ${top.toFixed(1)}V${bottom.toFixed(1)}`;
  }
  return (
    <Svg style={[styles.chunk, { left: start * pitch }]} width={CHUNK * pitch} height={height}>
      <Path d={d} stroke={color} strokeWidth={barWidth} strokeLinecap="round" />
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
  detail,
  detailMs = 100,
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
  upcomingColor = '#E5E7EB',
  playheadColor = '#FFFFFF',
  fadeColor,
  fadeWidth = 64,
  barWidth = 3,
  barGap = 2,
  showTimestamp = true,
  timestampStyle,
  timestampContainerStyle,
}: WaveformProps) {
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
  const startSeek = () => callbacks.current.onSeekStart?.();
  const finishSeek = (ms: number) => {
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

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.container, { height }, style]} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <>
            <View style={[styles.half, { width: half, height }]}>
              <Animated.View style={[styles.track, { left: half, height }, trackStyle]}>
                {chunks.map(i => (
                  <Chunk key={i} index={i} detail={detail} color={playedColor} height={height} barWidth={barWidth} pitch={pitch} />
                ))}
              </Animated.View>
            </View>
            <View style={[styles.half, { left: half, width: half, height }]}>
              <Animated.View style={[styles.track, styles.trackStart, { height }, trackStyle]}>
                {chunks.map(i => (
                  <Chunk key={i} index={i} detail={detail} color={upcomingColor} height={height} barWidth={barWidth} pitch={pitch} />
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
            <View pointerEvents="none" style={[styles.playhead, { left: half - 1, height, backgroundColor: playheadColor }]} />
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
  playhead: { position: 'absolute', top: 0, width: 2, borderRadius: 1 },
  bubble: { position: 'absolute', width: 64, borderRadius: 16, backgroundColor: '#fff', zIndex: 2 },
  timestamp: { color: '#111', padding: 4, fontSize: 12, textAlign: 'center' },
});
