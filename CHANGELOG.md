# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.1] - 2026-09-21

### Added
- `<Waveform />` scrolling scrubber component with dual played/upcoming colour layers.
- Frame-accurate UI-thread synchronization clock with drift correction and seek snapping.
- Native loudness decoders for Android (`MediaCodec`) and iOS (`AVAudioFile`).
- Dual decoding modes: `read` (full decode with 100ms detail track) and `readQuick` (~1s preview overview).
- `useWaveform` hook with automatic `quickFirst` progressive loading and `stored` database preloading.
- `normalizeLoudness` utility mapping dBFS levels onto a fixed 40 dB perceptual display range.
- Cache utilities: `decodeWaveform`, `cacheWaveform`, `getCachedWaveform`, `clearWaveformCache`, `getDurationSeconds`.
- Published simultaneously as `react-native-waveform-view` and short alias `rn-waveform`.
