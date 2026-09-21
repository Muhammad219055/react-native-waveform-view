import React from 'react';
import { create, act } from 'react-test-renderer';
import { useWaveform, UseWaveformOptions } from '../src/useWaveform';
import * as decodeModule from '../src/decode';
import { WaveformData } from '../src/decode';

let hookResult: ReturnType<typeof useWaveform>;

function TestComponent({
  path,
  options,
}: {
  path?: string | null;
  options?: UseWaveformOptions;
}) {
  hookResult = useWaveform(path, options);
  return null;
}

describe('useWaveform', () => {
  let decodeSpy: jest.SpyInstance;

  beforeEach(() => {
    decodeModule.clearWaveformCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    decodeSpy?.mockRestore();
  });

  it('renders instantly on first frame when stored waveform is passed', () => {
    const stored: WaveformData = {
      overview: [0.5, 0.6, 0.7],
      detail: [0.2, 0.4, 0.6],
      detailMs: 100,
    };
    decodeSpy = jest.spyOn(decodeModule, 'decodeWaveform');

    let renderer: any;
    act(() => {
      renderer = create(<TestComponent path="file:///stored.mp3" options={{ stored }} />);
    });

    expect(hookResult.loading).toBe(false);
    expect(hookResult.waveform).toEqual(stored);
    expect(hookResult.samples).toBeDefined();
    expect(hookResult.detail).toBeDefined();
    expect(hookResult.detailMs).toBe(100);
    expect(decodeSpy).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('handles quick-then-full ordering', async () => {
    let resolveQuick: (val: any) => void = () => {};
    let resolveFull: (val: any) => void = () => {};

    decodeSpy = jest.spyOn(decodeModule, 'decodeWaveform').mockImplementation((_path, opts) => {
      if (opts?.quick) {
        return new Promise(res => { resolveQuick = res; });
      }
      return new Promise(res => { resolveFull = res; });
    });

    let renderer: any;
    act(() => {
      renderer = create(<TestComponent path="file:///stream.mp3" />);
    });

    // Initially loading
    expect(hookResult.loading).toBe(true);
    expect(hookResult.samples).toBeUndefined();
    expect(hookResult.detail).toBeUndefined();

    // 1. Quick resolves
    const quickData: WaveformData = {
      overview: [0.3, 0.4, 0.5],
      detail: [],
      detailMs: 100,
    };
    await act(async () => {
      resolveQuick(quickData);
    });

    expect(hookResult.loading).toBe(false);
    expect(hookResult.samples).toBeDefined();
    expect(hookResult.detail).toBeUndefined(); // detail not available in quick

    // 2. Full resolves
    const fullData: WaveformData = {
      overview: [0.35, 0.45, 0.55],
      detail: [0.1, 0.2, 0.3],
      detailMs: 100,
    };
    await act(async () => {
      resolveFull(fullData);
    });

    expect(hookResult.loading).toBe(false);
    expect(hookResult.samples).toBeDefined();
    expect(hookResult.detail).toBeDefined(); // detail now available
    expect(hookResult.waveform).toEqual(fullData);

    act(() => renderer.unmount());
  });

  it('guarantees late quick resolution never overwrites finished full decode', async () => {
    let resolveQuick: (val: any) => void = () => {};
    let resolveFull: (val: any) => void = () => {};

    decodeSpy = jest.spyOn(decodeModule, 'decodeWaveform').mockImplementation((_path, opts) => {
      if (opts?.quick) {
        return new Promise(res => { resolveQuick = res; });
      }
      return new Promise(res => { resolveFull = res; });
    });

    let renderer: any;
    act(() => {
      renderer = create(<TestComponent path="file:///race.mp3" />);
    });

    const fullData: WaveformData = {
      overview: [0.8, 0.9],
      detail: [0.5, 0.6],
      detailMs: 100,
    };

    // Full resolves FIRST
    await act(async () => {
      resolveFull(fullData);
    });

    expect(hookResult.waveform).toEqual(fullData);
    expect(hookResult.detail).toBeDefined();

    // Quick resolves LATER
    const lateQuickData: WaveformData = {
      overview: [0.1, 0.2],
      detail: [],
      detailMs: 100,
    };
    await act(async () => {
      resolveQuick(lateQuickData);
    });

    // Waveform must remain fullData!
    expect(hookResult.waveform).toEqual(fullData);
    expect(hookResult.detail).toBeDefined();

    act(() => renderer.unmount());
  });

  it('cancels pending updates on path change mid-flight', async () => {
    let resolveA: (val: any) => void = () => {};
    let resolveB: (val: any) => void = () => {};

    decodeSpy = jest.spyOn(decodeModule, 'decodeWaveform').mockImplementation((path, opts) => {
      if (path === 'file:///a.mp3') {
        return new Promise(res => { resolveA = res; });
      }
      return new Promise(res => { resolveB = res; });
    });

    let renderer: any;
    act(() => {
      renderer = create(<TestComponent path="file:///a.mp3" options={{ quickFirst: false }} />);
    });

    // Switch path before A resolves
    act(() => {
      renderer.update(<TestComponent path="file:///b.mp3" options={{ quickFirst: false }} />);
    });

    // A resolves now
    await act(async () => {
      resolveA({ overview: [0.9], detail: [0.9], detailMs: 100 });
    });

    // Should not have applied A
    expect(hookResult.waveform).toBeUndefined();

    // B resolves
    const bData = { overview: [0.2], detail: [0.2], detailMs: 100 };
    await act(async () => {
      resolveB(bData);
    });

    expect(hookResult.waveform).toEqual(bData);

    act(() => renderer.unmount());
  });

  it('handles decode failure state', async () => {
    decodeSpy = jest.spyOn(decodeModule, 'decodeWaveform').mockRejectedValue(new Error('fail'));

    let renderer: any;
    await act(async () => {
      renderer = create(<TestComponent path="file:///bad.mp3" />);
    });

    expect(hookResult.failed).toBe(true);
    expect(hookResult.loading).toBe(false);
    expect(hookResult.waveform).toBeUndefined();

    act(() => renderer.unmount());
  });
});
