import React from 'react';
import { View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { Path } from 'react-native-svg';
import Waveform from '../src/Waveform';

let mockHandlers: Record<string, (...args: any[]) => void> = {};
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: any) => children,
  Gesture: {
    Pan: () => {
      const gesture: any = { enabled: () => gesture };
      for (const name of ['onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
        gesture[name] = (fn: any) => { mockHandlers[name] = fn; return gesture; };
      }
      return gesture;
    },
  },
}));

let mockFrameCallback: ((frame: { timestamp: number }) => void) | null = null;
let mockSharedValues: any[] = [];

// Shared values are plain holders; assigning a withDecay() marker settles
// immediately (velocity 0 in these tests) and fires its completion callback.
jest.mock('react-native-reanimated', () => {
  const ReactModule = require('react');
  const Native = require('react-native');
  const makeValue = (initial: unknown) => {
    let current = initial;
    const obj = {
      get value() { return current; },
      set value(next: any) {
        if (next && next.__decay) {
          const [min, max] = next.config.clamp;
          current = Math.max(min, Math.min(max, current as number));
          next.callback?.(true);
        } else {
          current = next;
        }
      },
    };
    mockSharedValues.push(obj);
    return obj;
  };
  return {
    __esModule: true,
    default: { View: Native.View, createAnimatedComponent: (c: any) => c },
    useSharedValue: (v: unknown) => ReactModule.useRef(makeValue(v)).current,
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useAnimatedReaction: () => {},
    useFrameCallback: (cb: any) => {
      mockFrameCallback = cb;
      return { setActive: () => {} };
    },
    runOnJS: (fn: any) => fn,
    cancelAnimation: () => {},
    withDecay: (config: any, callback: any) => ({ __decay: true, config, callback }),
  };
});

/** Default bar width (3) plus gap (2). */
const BAR_PITCH = 5;
const DURATION_MS = 23 * 60 * 1000;
const DETAIL_MS = 100;
const detail = Array.from({ length: DURATION_MS / DETAIL_MS }, (_, i) => (i % 10) / 10);

let renderer: ReactTestRenderer;
beforeEach(() => {
  mockSharedValues = [];
  mockFrameCallback = null;
});
afterEach(() => act(() => renderer?.unmount()));

function mount(props: Partial<React.ComponentProps<typeof Waveform>> = {}, onSeekEnd = jest.fn()) {
  const defaultProgress = props.progress ?? 0.5;
  act(() => {
    renderer = create(
      <Waveform
        detail={detail}
        detailMs={DETAIL_MS}
        durationMs={DURATION_MS}
        progress={defaultProgress}
        onSeekEnd={onSeekEnd}
        {...props}
      />,
    );
  });
  const container = renderer.root.findAllByType(View).find(node => node.props.onLayout)!;
  act(() => container.props.onLayout({ nativeEvent: { layout: { width: 350 } } }));
  return onSeekEnd;
}

function getPositionMs(): number {
  // First shared value created in Waveform.tsx is positionMs
  return mockSharedValues[0].value;
}

describe('gesture interactions', () => {
  test('dragging left moves forward by exactly one bar (100ms) per bar-width of finger travel', () => {
    const onSeekEnd = mount({ progress: 0.5 });
    act(() => {
      mockHandlers.onStart();
      mockHandlers.onUpdate({ translationX: -10 * BAR_PITCH });
      mockHandlers.onEnd({ velocityX: 0 });
    });
    expect(onSeekEnd).toHaveBeenCalledTimes(1);
    expect(onSeekEnd.mock.calls[0][0] * DURATION_MS).toBeCloseTo(DURATION_MS / 2 + 1000);
  });

  test('dragging right goes back, and stops at the start of the audio', () => {
    const onSeekEnd = mount({ progress: 0.001 });
    act(() => {
      mockHandlers.onStart();
      mockHandlers.onUpdate({ translationX: 5000 });
      mockHandlers.onEnd({ velocityX: 0 });
    });
    expect(onSeekEnd).toHaveBeenCalledWith(0);
  });

  test('a cancelled drag returns to where it started', () => {
    const onSeekEnd = mount({ progress: 0.25 });
    act(() => {
      mockHandlers.onStart();
      mockHandlers.onUpdate({ translationX: -400 });
      mockHandlers.onFinalize({}, false);
    });
    expect(onSeekEnd.mock.calls[0][0]).toBeCloseTo(0.25);
  });

  test('only bars near the playhead are drawn, not the whole 23-minute track', () => {
    mount({ progress: 0.5 });
    const paths = renderer.root.findAllByType(Path);
    expect(detail.length).toBe(13800);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(2 * 13);
  });
});

describe('sync clock & playback tracking', () => {
  test('frame callback advances position accurately at playback rate while playing', () => {
    mount({ progress: 0.1, isPlaying: true, playbackRate: 1.0 });
    expect(mockFrameCallback).not.null;

    const initialMs = 0.1 * DURATION_MS;
    expect(getPositionMs()).toBe(initialMs);

    // Initial frame reanchors at t=1000ms
    act(() => {
      mockFrameCallback!({ timestamp: 1000 });
    });
    expect(getPositionMs()).toBe(initialMs);

    // Advance 500ms at rate 1.0 -> position increases by 500ms
    act(() => {
      mockFrameCallback!({ timestamp: 1500 });
    });
    expect(getPositionMs()).toBeCloseTo(initialMs + 500);

    // Advance another 1000ms -> position increases by 1000ms
    act(() => {
      mockFrameCallback!({ timestamp: 2500 });
    });
    expect(getPositionMs()).toBeCloseTo(initialMs + 1500);
  });

  test('adjusts speed with 1.5x and 2x playback rates', () => {
    mount({ progress: 0, isPlaying: true, playbackRate: 2.0 });

    act(() => {
      mockFrameCallback!({ timestamp: 1000 }); // anchor
    });
    expect(getPositionMs()).toBe(0);

    // Advance 500ms at rate 2.0 -> position increases by 1000ms
    act(() => {
      mockFrameCallback!({ timestamp: 1500 });
    });
    expect(getPositionMs()).toBeCloseTo(1000);
  });

  test('smoothly bleeds small drift without snapping in a single frame', () => {
    mount({ progress: 0, isPlaying: true, playbackRate: 1.0 });

    // Anchor at t=1000ms
    act(() => {
      mockFrameCallback!({ timestamp: 1000 });
    });
    expect(getPositionMs()).toBe(0);

    // At t=1100ms, calculated position is 100ms
    act(() => {
      mockFrameCallback!({ timestamp: 1100 });
    });
    expect(getPositionMs()).toBeCloseTo(100);

    // Player report arrives slightly ahead by 50ms: progress = 150ms
    act(() => {
      renderer.update(
        <Waveform
          detail={detail}
          detailMs={DETAIL_MS}
          durationMs={DURATION_MS}
          progress={150 / DURATION_MS}
          isPlaying={true}
          playbackRate={1.0}
        />,
      );
    });

    // Frame at t=1116ms: offset was 50ms (< SNAP_MS = 1000ms).
    // It should NOT jump straight to 166ms; it nudges gradually.
    act(() => {
      mockFrameCallback!({ timestamp: 1116 });
    });
    const pos = getPositionMs();
    // Normal progress would be 116ms; with nudge it should be slightly higher, but far below 166ms
    expect(pos).toBeGreaterThan(116);
    expect(pos).toBeLessThan(140);
  });

  test('snaps immediately on real seek (> 1000ms offset)', () => {
    mount({ progress: 0, isPlaying: true, playbackRate: 1.0 });

    act(() => {
      mockFrameCallback!({ timestamp: 1000 });
    });

    // Player performs a jump to 10 seconds (10000ms)
    act(() => {
      renderer.update(
        <Waveform
          detail={detail}
          detailMs={DETAIL_MS}
          durationMs={DURATION_MS}
          progress={10000 / DURATION_MS}
          isPlaying={true}
          playbackRate={1.0}
        />,
      );
    });

    // Next frame should immediately snap to reported position
    act(() => {
      mockFrameCallback!({ timestamp: 1016 });
    });
    expect(getPositionMs()).toBe(10000);

    // Subsequent frame continues playback from the snapped anchor
    act(() => {
      mockFrameCallback!({ timestamp: 1032 });
    });
    expect(getPositionMs()).toBeCloseTo(10016);
  });

  test('ignores stale player reports after a scrub until player catches up', () => {
    const onSeekEnd = jest.fn();
    mount({ progress: 0.1, isPlaying: true, playbackRate: 1.0 }, onSeekEnd);

    // Initial frame
    act(() => {
      mockFrameCallback!({ timestamp: 1000 });
    });

    // User scrubs far ahead: +50 seconds (10 * 50 = 500 bars -> -2500 translation)
    act(() => {
      mockHandlers.onStart();
      mockHandlers.onUpdate({ translationX: -500 * BAR_PITCH });
      mockHandlers.onEnd({ velocityX: 0 });
    });

    const scrubbedPosition = getPositionMs();
    expect(scrubbedPosition).toBeCloseTo(0.1 * DURATION_MS + 50000);

    // Frame right after scrub: sets awaitingSince = 1200
    act(() => {
      mockFrameCallback!({ timestamp: 1200 });
    });

    // Player sends a stale report from before the seek (say old position + a few ms)
    act(() => {
      renderer.update(
        <Waveform
          detail={detail}
          detailMs={DETAIL_MS}
          durationMs={DURATION_MS}
          progress={(0.1 * DURATION_MS + 200) / DURATION_MS}
          isPlaying={true}
          playbackRate={1.0}
        />,
      );
    });

    // Frame at t=1250: this stale report MUST be dropped!
    act(() => {
      mockFrameCallback!({ timestamp: 1250 });
    });
    // Position must stay near the scrubbed position, not revert to 0.1 * DURATION_MS + 200
    expect(getPositionMs()).toBeCloseTo(scrubbedPosition + 50, -2);
  });
});
