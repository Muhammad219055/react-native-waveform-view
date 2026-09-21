import { NativeModules } from 'react-native';
import {
  decodeWaveform,
  getDurationSeconds,
  cacheWaveform,
  getCachedWaveform,
  clearWaveformCache,
  isValidWaveform,
  DEFAULT_BINS,
  DETAIL_MS,
  WaveformData,
} from '../src/decode';

describe('isValidWaveform', () => {
  it('validates proper waveform payload', () => {
    const valid: WaveformData = {
      overview: new Array(DEFAULT_BINS).fill(0.5),
      detail: [0.1, 0.2, 0.3],
      detailMs: DETAIL_MS,
    };
    expect(isValidWaveform(valid)).toBe(true);
    expect(isValidWaveform(valid, DEFAULT_BINS)).toBe(true);
  });

  it('rejects non-object or null values', () => {
    expect(isValidWaveform(null)).toBe(false);
    expect(isValidWaveform(undefined)).toBe(false);
    expect(isValidWaveform('string')).toBe(false);
    expect(isValidWaveform(123)).toBe(false);
  });

  it('rejects wrong overview bin length or invalid levels', () => {
    expect(
      isValidWaveform({
        overview: new Array(10).fill(0.5),
        detail: [0.5],
        detailMs: 100,
      }),
    ).toBe(false);

    expect(
      isValidWaveform({
        overview: new Array(DEFAULT_BINS).fill(1.5), // out of 0..1 bounds
        detail: [0.5],
        detailMs: 100,
      }),
    ).toBe(false);

    expect(
      isValidWaveform({
        overview: new Array(DEFAULT_BINS).fill(NaN),
        detail: [0.5],
        detailMs: 100,
      }),
    ).toBe(false);

    expect(
      isValidWaveform({
        overview: new Array(DEFAULT_BINS).fill(0.5),
        detail: [-0.1], // detail out of bounds
        detailMs: 100,
      }),
    ).toBe(false);
  });
});

describe('cache functions', () => {
  beforeEach(() => {
    clearWaveformCache();
  });

  it('seeds and retrieves from cache manually', () => {
    const data: WaveformData = {
      overview: new Array(DEFAULT_BINS).fill(0.2),
      detail: [0.2],
      detailMs: 100,
    };
    expect(getCachedWaveform('file:///test.mp3')).toBeUndefined();
    cacheWaveform('file:///test.mp3', data);
    expect(getCachedWaveform('file:///test.mp3')).toEqual(data);
  });

  it('clears specific path or whole cache', () => {
    const data: WaveformData = {
      overview: new Array(DEFAULT_BINS).fill(0.2),
      detail: [0.2],
      detailMs: 100,
    };
    cacheWaveform('file:///1.mp3', data);
    cacheWaveform('file:///2.mp3', data);

    clearWaveformCache('file:///1.mp3');
    expect(getCachedWaveform('file:///1.mp3')).toBeUndefined();
    expect(getCachedWaveform('file:///2.mp3')).toEqual(data);

    clearWaveformCache();
    expect(getCachedWaveform('file:///2.mp3')).toBeUndefined();
  });
});

describe('decodeWaveform & getDurationSeconds', () => {
  beforeEach(() => {
    clearWaveformCache();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('decodes audio file and caches full result', async () => {
    const mockOverview = new Array(DEFAULT_BINS).fill(0.4);
    const mockDetail = [0.1, 0.4, 0.8];
    const mockNative = {
      getWaveform: jest.fn().mockResolvedValue({
        overview: mockOverview,
        detail: mockDetail,
        detailMs: 100,
      }),
      getDurationSeconds: jest.fn().mockResolvedValue(12.5),
    };
    NativeModules.RNWaveform = mockNative;

    const res = await decodeWaveform('file:///audio.mp3');
    expect(res).toEqual({
      overview: mockOverview,
      detail: mockDetail,
      detailMs: 100,
    });
    expect(mockNative.getWaveform).toHaveBeenCalledWith('file:///audio.mp3', DEFAULT_BINS, false);

    // Subsequent call should hit cache without calling native again
    const cachedRes = await decodeWaveform('file:///audio.mp3');
    expect(cachedRes).toEqual(res);
    expect(mockNative.getWaveform).toHaveBeenCalledTimes(1);
  });

  it('does not cache quick decodes', async () => {
    const mockOverview = new Array(DEFAULT_BINS).fill(0.5);
    const mockNative = {
      getWaveform: jest.fn().mockResolvedValue({
        overview: mockOverview,
        detail: [],
        detailMs: 100,
      }),
    };
    NativeModules.RNWaveform = mockNative;

    const quick = await decodeWaveform('file:///audio.mp3', { quick: true });
    expect(quick.overview).toEqual(mockOverview);
    expect(getCachedWaveform('file:///audio.mp3')).toBeUndefined();

    // Calling again with quick still calls native
    await decodeWaveform('file:///audio.mp3', { quick: true });
    expect(mockNative.getWaveform).toHaveBeenCalledTimes(2);
  });

  it('deduplicates in-flight concurrent requests', async () => {
    let resolveNative: (val: any) => void = () => {};
    const nativePromise = new Promise(resolve => {
      resolveNative = resolve;
    });
    const mockNative = {
      getWaveform: jest.fn().mockReturnValue(nativePromise),
    };
    NativeModules.RNWaveform = mockNative;

    const p1 = decodeWaveform('file:///concurrent.mp3');
    const p2 = decodeWaveform('file:///concurrent.mp3');
    expect(mockNative.getWaveform).toHaveBeenCalledTimes(1);

    resolveNative({
      overview: new Array(DEFAULT_BINS).fill(0.3),
      detail: [0.3],
      detailMs: 100,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
  });

  it('rejects invalid payload returned from native module', async () => {
    const mockNative = {
      getWaveform: jest.fn().mockResolvedValue({
        overview: [1, 2, 3], // invalid length
        detail: [],
      }),
    };
    NativeModules.RNWaveform = mockNative;

    await expect(decodeWaveform('file:///corrupt.mp3')).rejects.toThrow(
      'Invalid decoded audio waveform',
    );
  });

  it('times out if native module hangs', async () => {
    jest.useFakeTimers();
    const mockNative = {
      getWaveform: jest.fn().mockReturnValue(new Promise(() => {})), // never resolves
    };
    NativeModules.RNWaveform = mockNative;

    const decodePromise = decodeWaveform('file:///hang.mp3', { quick: true });
    jest.advanceTimersByTime(16000); // quick timeout is 15000ms

    await expect(decodePromise).rejects.toThrow('Waveform decode timed out');
  });

  it('retrieves duration in seconds', async () => {
    const mockNative = {
      getDurationSeconds: jest.fn().mockResolvedValue(123.45),
    };
    NativeModules.RNWaveform = mockNative;

    const duration = await getDurationSeconds('file:///song.mp3');
    expect(duration).toBe(123.45);
    expect(mockNative.getDurationSeconds).toHaveBeenCalledWith('file:///song.mp3');
  });

  it('rejects when native module is missing', async () => {
    // Force native module to be undefined by re-requiring decode with undefined native
    jest.isolateModules(async () => {
      const { NativeModules: NM } = require('react-native');
      const original = NM.RNWaveform;
      delete NM.RNWaveform;
      const { decodeWaveform: dW, getDurationSeconds: gD } = require('../src/decode');
      await expect(dW('file:///test.mp3')).rejects.toThrow(
        /native module not found/,
      );
      await expect(gD('file:///test.mp3')).rejects.toThrow(
        /native module not found/,
      );
      NM.RNWaveform = original;
    });
  });
});
