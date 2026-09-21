import React from 'react';
import { View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { Path } from 'react-native-svg';
import Waveform, { resampleDetail } from '../src/Waveform';

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

describe('resampleDetail', () => {
  test('omitted msPerBar is a no-op — returns detail/detailMs unchanged (the default)', () => {
    const source = [0.1, 0.2, 0.3, 0.4];
    expect(resampleDetail(source, 100)).toEqual({ detail: source, detailMs: 100 });
  });

  test('groups adjacent values by average when msPerBar is a multiple of detailMs', () => {
    const source = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0];
    const result = resampleDetail(source, 100, 200);
    expect(result.detailMs).toBe(200);
    expect(result.detail).toEqual([0.1, 0.5, 0.9]);
  });

  test('a trailing partial group still averages just what it has', () => {
    const source = [0.0, 0.2, 0.4, 0.6, 0.8];
    const result = resampleDetail(source, 100, 300);
    expect(result.detailMs).toBe(300);
    expect(result.detail[0]).toBeCloseTo(0.2);
    expect(result.detail[1]).toBeCloseTo(0.7);
  });

  test('msPerBar below detailMs is clamped up — cannot synthesize finer detail than was decoded', () => {
    const source = [0.1, 0.2, 0.3];
    expect(resampleDetail(source, 100, 40)).toEqual({ detail: source, detailMs: 100 });
  });
});

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

  test('msPerBar makes a drag of one bar-width move that many ms, not detailMs', () => {
    // 5 source slices (500ms) grouped into each drawn bar.
    const onSeekEnd = mount({ progress: 0.5, msPerBar: 500 });
    act(() => {
      mockHandlers.onStart();
      mockHandlers.onUpdate({ translationX: -1 * BAR_PITCH });
      mockHandlers.onEnd({ velocityX: 0 });
    });
    expect(onSeekEnd.mock.calls[0][0] * DURATION_MS).toBeCloseTo(DURATION_MS / 2 + 500);
  });
});

describe('playhead line customization', () => {
  // Same reasoning as the handle: the slot (fixed width/height, array style)
  // wraps a preset/injected child whose own style is a plain object — search
  // for that shape rather than by child position or composite/host layering.
  const findSlot = (width: number) =>
    renderer.root.findAll(
      node => node.type === View && node.props.style?.some?.((s: any) => s?.width === width && s?.height !== undefined && s?.left !== undefined),
    )[0];
  const findPresetShape = (width: number) =>
    findSlot(width).findAll(node => node.type === View && node.props.style && !Array.isArray(node.props.style));

  test('a "line" playhead is shown by default, matching the original hardcoded look', () => {
    mount({ progress: 0.5 });
    const shapes = findPresetShape(2);
    expect(shapes.length).toBe(1);
    expect(shapes[0].props.style).toMatchObject({ width: 2, borderRadius: 1, backgroundColor: '#FFFFFF' });
  });

  test('playheadWidth and playheadColor override independently', () => {
    mount({ progress: 0.5, playheadColor: '#22D3EE', playheadWidth: 4 });
    const shapes = findPresetShape(4);
    expect(shapes[0].props.style).toMatchObject({ width: 4, backgroundColor: '#22D3EE' });
  });

  test.each([
    ['thick', { width: 4 }],
    ['dashed', { width: 0, borderLeftWidth: 2, borderStyle: 'dashed' }],
    ['glow', { width: 2, shadowRadius: 6 }],
  ] as const)('playheadPreset="%s" draws that style', (preset, expected) => {
    mount({ progress: 0.5, playheadPreset: preset });
    expect(findPresetShape(2)[0].props.style).toMatchObject(expected);
  });

  test('playheadPreset="none" shows an empty slot, not a line', () => {
    mount({ progress: 0.5, playheadPreset: 'none' });
    expect(findPresetShape(2).length).toBe(0);
  });

  test('renderPlayhead fully replaces the preset, receiving the resolved color/width/height', () => {
    const renderPlayhead = jest.fn(() => <View testID="custom-playhead" />);
    mount({ progress: 0.5, playheadColor: '#F472B6', playheadWidth: 3, height: 64, renderPlayhead });
    expect(renderPlayhead).toHaveBeenCalledWith({ color: '#F472B6', width: 3, height: 64 });
    expect(renderer.root.findByProps({ testID: 'custom-playhead' })).toBeTruthy();
  });
});

describe('handle customization', () => {
  // The slot is the outer positioned box (array style; React Native's View
  // shows up as a composite instance wrapping a host instance, both carrying
  // that same array, so child-index lookups land on the wrong layer). Presets
  // are the only Views in this component with a plain (non-array) style
  // object, so searching for that shape finds the real preset/injected node
  // regardless of how many composite/host layers sit above it.
  const findSlot = (radius: number) =>
    renderer.root.findAll(
      node => node.type === View && node.props.style?.some?.((s: any) => s?.width === radius * 2 && s?.height === radius * 2),
    )[0];
  const findPresetShape = (radius: number) =>
    findSlot(radius).findAll(node => node.type === View && node.props.style && !Array.isArray(node.props.style));

  test('a "dot" handle is shown by default, sized and coloured to match the playhead', () => {
    mount({ progress: 0.5 });
    const shapes = findPresetShape(5);
    expect(shapes.length).toBe(1);
    expect(shapes[0].props.style).toMatchObject({ width: 10, height: 10, borderRadius: 5, backgroundColor: '#FFFFFF' });
  });

  test('showHandle={false} renders no handle at all', () => {
    mount({ progress: 0.5, showHandle: false });
    expect(findSlot(5)).toBeUndefined();
  });

  test('handleColor and handleRadius override independently of the playhead', () => {
    mount({ progress: 0.5, playheadColor: '#000000', handleColor: '#A855F7', handleRadius: 8 });
    const shapes = findPresetShape(8);
    expect(shapes.length).toBe(1);
    expect(shapes[0].props.style).toMatchObject({ backgroundColor: '#A855F7' });
  });

  test.each([
    ['ring', { borderWidth: 2, borderColor: '#FFFFFF' }],
    ['pill', { width: 5.5, height: 13 }],
    ['bar', { width: 15, height: 3.5 }],
  ] as const)('handlePreset="%s" draws that shape', (preset, expected) => {
    mount({ progress: 0.5, handlePreset: preset });
    expect(findPresetShape(5)[0].props.style).toMatchObject(expected);
  });

  test('handlePreset="none" shows an empty slot, not a shape', () => {
    mount({ progress: 0.5, handlePreset: 'none' });
    expect(findPresetShape(5).length).toBe(0);
  });

  test('renderHandle fully replaces the preset, receiving the resolved color/radius', () => {
    const renderHandle = jest.fn(() => <View testID="custom-handle" />);
    mount({ progress: 0.5, handleColor: '#22D3EE', handleRadius: 7, renderHandle });
    expect(renderHandle).toHaveBeenCalledWith({ color: '#22D3EE', radius: 7, dragging: false });
    expect(renderer.root.findByProps({ testID: 'custom-handle' })).toBeTruthy();
  });

  test('renderHandle sees live dragging state, true while scrubbing and false again on release', () => {
    const renderHandle = jest.fn(() => <View />);
    mount({ progress: 0.5, renderHandle });
    expect(renderHandle.mock.calls.at(-1)?.[0].dragging).toBe(false);

    act(() => mockHandlers.onStart());
    expect(renderHandle.mock.calls.at(-1)?.[0].dragging).toBe(true);

    act(() => {
      mockHandlers.onUpdate({ translationX: 0 });
      mockHandlers.onEnd({ velocityX: 0 });
    });
    expect(renderHandle.mock.calls.at(-1)?.[0].dragging).toBe(false);
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

  describe('gradient support', () => {
    it('renders with default gradient when playedGradient={true}', () => {
      const detail = [0.1, 0.5, 0.9, 0.2];
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(
          <Waveform
            detail={detail}
            detailMs={100}
            durationMs={400}
            progress={0}
            playedGradient={true}
            upcomingColor="#334155"
          />,
        );
      });

      const root = renderer.root;
      act(() => {
        root.findByType(View).props.onLayout({
          nativeEvent: { layout: { width: 300, height: 64, x: 0, y: 0 } },
        });
      });

      const paths = renderer.root.findAllByType(Path);
      expect(paths.length).toBeGreaterThan(0);
      // The played path should reference the gradient ID
      const strokeValues = paths.map(p => p.props.stroke);
      expect(strokeValues.some(s => typeof s === 'string' && s.startsWith('url(#grad_p_'))).toBe(true);
      // Upcoming path should use solid color upcomingColor
      expect(strokeValues.some(s => s === '#334155')).toBe(true);
    });

    it('renders with custom playedGradient colors', () => {
      const detail = [0.05, 0.4, 0.85];
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(
          <Waveform
            detail={detail}
            detailMs={100}
            durationMs={300}
            progress={0}
            playedGradient={{
              flat: '#EAB308',
              normal: '#22C55E',
              peak: '#EF4444',
            }}
            upcomingGradient={{
              flat: '#713F12',
              normal: '#14532D',
              peak: '#7F1D1D',
            }}
          />,
        );
      });

      const root = renderer.root;
      act(() => {
        root.findByType(View).props.onLayout({
          nativeEvent: { layout: { width: 300, height: 64, x: 0, y: 0 } },
        });
      });

      const paths = renderer.root.findAllByType(Path);
      const strokeValues = paths.map(p => p.props.stroke);
      expect(strokeValues.some(s => typeof s === 'string' && s.startsWith('url(#grad_p_'))).toBe(true);
      expect(strokeValues.some(s => typeof s === 'string' && s.startsWith('url(#grad_u_'))).toBe(true);
    });
  });
});
