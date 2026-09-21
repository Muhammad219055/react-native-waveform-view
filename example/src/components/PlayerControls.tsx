import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type PlayerControlsProps = {
  isPlaying: boolean;
  playbackRate: number;
  currentPositionMs: number;
  durationMs: number;
  onTogglePlay: () => void;
  onRateChange: (rate: number) => void;
  onRestart: () => void;
};

const formatTime = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

export function PlayerControls({
  isPlaying,
  playbackRate,
  currentPositionMs,
  durationMs,
  onTogglePlay,
  onRateChange,
  onRestart,
}: PlayerControlsProps) {
  const rates = [0.5, 1.0, 1.5, 2.0];

  return (
    <View style={styles.container}>
      <View style={styles.timeRow}>
        <Text style={styles.timeText}>
          {formatTime(currentPositionMs)} / {formatTime(durationMs)}
        </Text>
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.secondaryButton} onPress={onRestart}>
          <Text style={styles.secondaryButtonText}>⏮ Restart</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.playButton} onPress={onTogglePlay}>
          <Text style={styles.playButtonText}>{isPlaying ? '⏸ Pause' : '▶ Play'}</Text>
        </TouchableOpacity>

        <View style={styles.rateContainer}>
          {rates.map(r => (
            <TouchableOpacity
              key={r}
              style={[styles.rateButton, playbackRate === r && styles.rateButtonActive]}
              onPress={() => onRateChange(r)}
            >
              <Text style={[styles.rateText, playbackRate === r && styles.rateTextActive]}>
                {r}x
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#1E293B',
    borderRadius: 12,
    marginVertical: 12,
  },
  timeRow: {
    alignItems: 'center',
    marginBottom: 12,
  },
  timeText: {
    color: '#94A3B8',
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  playButton: {
    backgroundColor: '#8B5CF6',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  playButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  secondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#334155',
    borderRadius: 8,
  },
  secondaryButtonText: {
    color: '#E2E8F0',
    fontSize: 13,
  },
  rateContainer: {
    flexDirection: 'row',
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 2,
  },
  rateButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  rateButtonActive: {
    backgroundColor: '#475569',
  },
  rateText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  rateTextActive: {
    color: '#FFFFFF',
  },
});
