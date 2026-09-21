import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Waveform, useWaveform } from 'react-native-waveform-view';
import { useSound } from 'react-native-nitro-sound';
import { AudioSelector } from '../components/AudioSelector';
import { PlayerControls } from '../components/PlayerControls';
import { FIXTURES, AudioFixture } from '../fixtures/fixtureList';

export function DisplayOnlyScreen() {
  const [selected, setSelected] = useState<AudioFixture>(FIXTURES[0]);
  const { detail, detailMs } = useWaveform(selected.path, { quickFirst: true });

  const { state, startPlayer, pausePlayer, resumePlayer, seekToPlayer } =
    useSound({ subscriptionDuration: 100 });

  const durationMs = state.duration > 0 ? state.duration : 10000;
  const currentPositionMs = state.currentPosition;
  const progress = durationMs > 0 ? currentPositionMs / durationMs : 0;

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Display-Only (Read Only)</Text>
      <Text style={styles.screenDescription}>
        Demonstrates omitting &apos;onSeekEnd&apos; to make the waveform display-only: tracks playback smoothly
        without accepting user drag/scrub gestures.
      </Text>

      <AudioSelector selectedFixture={selected} onSelect={setSelected} />

      <View style={styles.waveformContainer}>
        {detail && detail.length > 0 ? (
          <Waveform
            detail={detail}
            detailMs={detailMs || 100}
            durationMs={durationMs}
            progress={progress}
            isPlaying={state.isPlaying}
            // onSeekEnd omitted intentionally for display-only
            playedColor="#F59E0B"
            upcomingColor="#334155"
            fadeColor="#0F172A"
          />
        ) : (
          <View style={styles.centered}>
            <Text style={styles.mutedText}>Decoding audio...</Text>
          </View>
        )}
      </View>

      <PlayerControls
        isPlaying={state.isPlaying}
        playbackRate={1.0}
        currentPositionMs={currentPositionMs}
        durationMs={durationMs}
        onTogglePlay={() => {
          if (state.isPlaying) pausePlayer().catch(() => {});
          else resumePlayer().catch(() => startPlayer(selected.path).catch(() => {}));
        }}
        onRateChange={() => {}}
        onRestart={() => seekToPlayer(0).catch(() => {})}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  screenTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 4,
  },
  screenDescription: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 18,
    marginBottom: 12,
  },
  waveformContainer: {
    minHeight: 120,
    justifyContent: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 20,
    marginVertical: 8,
  },
  centered: {
    alignItems: 'center',
    padding: 20,
  },
  mutedText: {
    color: '#64748B',
    fontSize: 13,
  },
});
