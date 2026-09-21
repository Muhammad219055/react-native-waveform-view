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

// Shared values are plain holders; assigning a withDecay() marker settles
// immediately (velocity 0 in these tests) and fires its completion callback.
jest.mock('react-native-reanimated', () => {
  const ReactModule = require('react');
  const Native = require('react-native');
  const makeValue = (initial: unknown) => {
    let current = initial;
    return {
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
  };
  return {
    __esModule: true,
    default: { View: Native.View, createAnimatedComponent: (c: any) => c },
    useSharedValue: (v: unknown) => ReactModule.useRef(makeValue(v)).current,
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useAnimatedReaction: () => {},
    useFrameCallback: () => ({ setActive: () => {} }),
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
afterEach(() => act(() => renderer.unmount()));

function mount(progress: number, onSeekEnd = jest.fn()) {
  act(() => {
    renderer = create(
      <Waveform
        detail={detail}
        detailMs={DETAIL_MS}
        durationMs={DURATION_MS}
        progress={progress}
        onSeekEnd={onSeekEnd}
      />,
    );
  });
  const container = renderer.root.findAllByType(View).find(node => node.props.onLayout)!;
  act(() => container.props.onLayout({ nativeEvent: { layout: { width: 350 } } }));
  return onSeekEnd;
}

test('dragging left moves forward by exactly one bar (100ms) per bar-width of finger travel', () => {
  const onSeekEnd = mount(0.5);
  act(() => {
    mockHandlers.onStart();
    mockHandlers.onUpdate({ translationX: -10 * BAR_PITCH });
    mockHandlers.onEnd({ velocityX: 0 });
  });
  expect(onSeekEnd).toHaveBeenCalledTimes(1);
  expect(onSeekEnd.mock.calls[0][0] * DURATION_MS).toBeCloseTo(DURATION_MS / 2 + 1000);
});

test('dragging right goes back, and stops at the start of the audio', () => {
  const onSeekEnd = mount(0.001);
  act(() => {
    mockHandlers.onStart();
    mockHandlers.onUpdate({ translationX: 5000 });
    mockHandlers.onEnd({ velocityX: 0 });
  });
  expect(onSeekEnd).toHaveBeenCalledWith(0);
});

test('a cancelled drag returns to where it started', () => {
  const onSeekEnd = mount(0.25);
  act(() => {
    mockHandlers.onStart();
    mockHandlers.onUpdate({ translationX: -400 });
    mockHandlers.onFinalize({}, false);
  });
  expect(onSeekEnd.mock.calls[0][0]).toBeCloseTo(0.25);
});

test('only bars near the playhead are drawn, not the whole 23-minute track', () => {
  mount(0.5);
  // Each rendered chunk is one svg path per colour layer.
  const paths = renderer.root.findAllByType(Path);
  expect(detail.length).toBe(13800);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.length).toBeLessThanOrEqual(2 * 13);
});
