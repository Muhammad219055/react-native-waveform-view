#!/usr/bin/env bash
set -euo pipefail

DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures"
TMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tmp_audio"
mkdir -p "$DEST_DIR" "$TMP_DIR"

echo "=== Fetching Realistic Audio Files from the Web ==="

# 1. Real Speech Audio: Human Spoken Word (Voxserv / Freesound CC)
echo "1. Downloading real speech audio..."
curl -L -s -o "$TMP_DIR/raw_speech.wav" \
  "https://raw.githubusercontent.com/voxserv/audio_quality_testing_samples/master/mono_44100/127389__acclivity__thetimehascome.wav"

# Create fixture_10s_mono.wav (first 10 seconds of real human speech)
echo "   Creating fixture_10s_mono.wav (10s real speech)..."
ffmpeg -y -hide_banner -loglevel error \
  -i "$TMP_DIR/raw_speech.wav" \
  -t 10 \
  -ac 1 -ar 44100 \
  "$DEST_DIR/fixture_10s_mono.wav"

# 2. Real Music Audio: "Blizzard" by Kai Engel (Free Music Archive / Creative Commons)
echo "2. Downloading real music track (Kai Engel - Blizzard)..."
curl -L -s -o "$TMP_DIR/raw_music.mp3" \
  "https://raw.githubusercontent.com/rafaelreis-hotmart/Audio-Sample-files/master/sample.mp3"

# Create fixture_10s_stereo.mp3 (first 10 seconds of real music)
echo "   Creating fixture_10s_stereo.mp3 (10s real music)..."
ffmpeg -y -hide_banner -loglevel error \
  -i "$TMP_DIR/raw_music.mp3" \
  -t 10 \
  -ac 2 -b:a 192k \
  "$DEST_DIR/fixture_10s_stereo.mp3"

# Create fixture_3min_stereo.mp3 (full 3min real music song)
echo "   Creating fixture_3min_stereo.mp3 (3min real music)..."
ffmpeg -y -hide_banner -loglevel error \
  -i "$TMP_DIR/raw_music.mp3" \
  -t 180 \
  -ac 2 -b:a 192k \
  "$DEST_DIR/fixture_3min_stereo.mp3"

# 3. Real Voice Note: Clean Voice Sample
echo "3. Downloading real voice note sample..."
curl -L -s -o "$TMP_DIR/raw_voice.mp3" \
  "https://raw.githubusercontent.com/yaph/tts-samples/main/mp3/English/en-AU-NatashaNeural.mp3"

# Create fixture_10s_stereo.opus (10s real voice note in Opus)
echo "   Creating fixture_10s_stereo.opus (10s real voice note)..."
ffmpeg -y -hide_banner -loglevel error \
  -i "$TMP_DIR/raw_voice.mp3" \
  -t 10 \
  -c:a libopus -b:a 96k \
  "$DEST_DIR/fixture_10s_stereo.opus"

# 4. Real Podcast Episode: NPR Planet Money
echo "4. Downloading real podcast episode (NPR Planet Money)..."
PODCAST_URL=$(curl -s "https://feeds.npr.org/510289/podcast.xml" | grep -m 1 -o 'https://[^"]*default\.mp3' || true)
if [ -z "$PODCAST_URL" ]; then
  PODCAST_URL="https://npr.simplecastaudio.com/43b5acee-463e-4612-95ad-d2596d9dd337/episodes/015802bf-f8a4-4fdc-8b55-f82788d39640/audio/128/default.mp3"
fi
echo "   Source: $PODCAST_URL"
curl -L -s -o "$TMP_DIR/raw_podcast.mp3" "$PODCAST_URL"

# Create fixture_23min_mono.m4a (23 minutes = 1380s real podcast in M4A/AAC)
echo "   Creating fixture_23min_mono.m4a (23min real podcast)..."
ffmpeg -y -hide_banner -loglevel error \
  -i "$TMP_DIR/raw_podcast.mp3" \
  -t 1380 \
  -ac 1 -c:a aac -b:a 64k \
  "$DEST_DIR/fixture_23min_mono.m4a"

# Create fixture_2h_stereo.mp3 (2 hours = 7200s real audio stress test)
echo "   Creating fixture_2h_stereo.mp3 (2 hours real audio stress test)..."
# Loop the real podcast seamlessly to reach exactly 2 hours (7200s)
ffmpeg -y -hide_banner -loglevel error \
  -stream_loop 4 \
  -i "$TMP_DIR/raw_podcast.mp3" \
  -t 7200 \
  -ac 2 -c:a mp3 -b:a 64k \
  "$DEST_DIR/fixture_2h_stereo.mp3"

echo "=== All Realistic Audio Fixtures Ready ==="
ls -lh "$DEST_DIR"
