import { Platform } from 'react-native';

export type AudioFixture = {
  id: string;
  name: string;
  durationLabel: string;
  format: string;
  path: string;
};

// Android paths on device/emulator (pushed to /sdcard/Music/fixtures)
// iOS paths resolve from documents, bundle, or sandbox
const getFixturePath = (filename: string) => {
  if (Platform.OS === 'android') {
    return `/data/data/com.waveformexample/files/fixtures/${filename}`;
  }
  // On iOS Simulator, the full repo fixture directory is directly accessible
  return `file:///Users/muhammad/Desktop/rn-waveform/fixtures/${filename}`;
};

export const FIXTURES: AudioFixture[] = [
  {
    id: '10s_mono',
    name: 'Real Spoken Word',
    durationLabel: '10 sec',
    format: 'WAV (Real Voice)',
    path: getFixturePath('fixture_10s_mono.wav'),
  },
  {
    id: '10s_stereo',
    name: 'Classical Melody',
    durationLabel: '10 sec',
    format: 'MP3 (Kai Engel)',
    path: getFixturePath('fixture_10s_stereo.mp3'),
  },
  {
    id: '10s_opus',
    name: 'Voice Note',
    durationLabel: '5.4 sec',
    format: 'Opus (Voice Note)',
    path: getFixturePath('fixture_10s_stereo.opus'),
  },
  {
    id: '3min_stereo',
    name: 'Full Classical Song',
    durationLabel: '3 min',
    format: 'MP3 (Stereo)',
    path: getFixturePath('fixture_3min_stereo.mp3'),
  },
  {
    id: '23min_mono',
    name: 'NPR Planet Money',
    durationLabel: '23 min',
    format: 'M4A (Real Podcast)',
    path: getFixturePath('fixture_23min_mono.m4a'),
  },
  {
    id: '2h_stereo',
    name: '2hr Spoken Audio',
    durationLabel: '2 hours',
    format: 'MP3 (Stress Test)',
    path: getFixturePath('fixture_2h_stereo.mp3'),
  },
];
