#!/usr/bin/env bash
set -euo pipefail

DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures"
mkdir -p "$DEST_DIR"

echo "Generating test audio fixtures in $DEST_DIR..."

# 1. 10s Mono WAV (Speech-like modulated pulses with silent pauses)
echo "Generating 10s Mono WAV..."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=exprs='0.8*sin(2*PI*440*t)*sin(2*PI*3*t)*(gt(mod(t,3),0.8))':sample_rate=44100:duration=10" \
  -ac 1 "$DEST_DIR/fixture_10s_mono.wav"

# 2. 10s Stereo MP3
echo "Generating 10s Stereo MP3..."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=exprs='0.7*sin(2*PI*330*t)*sin(2*PI*2.5*t)*(gt(mod(t,2.5),0.6))|0.7*sin(2*PI*550*t)*sin(2*PI*2.5*t)*(gt(mod(t,2.5),0.6))':sample_rate=44100:duration=10" \
  -ac 2 -b:a 128k "$DEST_DIR/fixture_10s_stereo.mp3"

# 3. 10s Stereo Opus
echo "Generating 10s Stereo Opus..."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=exprs='0.7*sin(2*PI*400*t)*sin(2*PI*2*t)*(gt(mod(t,3),1.0))|0.7*sin(2*PI*600*t)*sin(2*PI*2*t)*(gt(mod(t,3),1.0))':sample_rate=48000:duration=10" \
  -c:a libopus -b:a 96k "$DEST_DIR/fixture_10s_stereo.opus"

# 4. 3min Stereo MP3 (Song / clip length, 180s)
echo "Generating 3min Stereo MP3..."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=exprs='0.85*sin(2*PI*300*t)*sin(2*PI*1.8*t)*(gt(mod(t,4),1.2))|0.85*sin(2*PI*500*t)*sin(2*PI*1.8*t)*(gt(mod(t,4),1.2))':sample_rate=44100:duration=180" \
  -ac 2 -b:a 128k "$DEST_DIR/fixture_3min_stereo.mp3"

# 5. 23min Mono M4A (Podcast episode length, 1380s)
echo "Generating 23min Mono M4A..."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=exprs='0.75*sin(2*PI*260*t)*sin(2*PI*2.2*t)*(gt(mod(t,3.5),0.8))':sample_rate=44100:duration=1380" \
  -ac 1 -c:a aac -b:a 64k "$DEST_DIR/fixture_23min_mono.m4a"

# 6. 2h Stereo MP3 (Long stress test, 7200s)
echo "Generating 2h Stereo MP3 (stress test)..."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=exprs='0.8*sin(2*PI*320*t)*sin(2*PI*2*t)*(gt(mod(t,5),1.5))|0.8*sin(2*PI*480*t)*sin(2*PI*2*t)*(gt(mod(t,5),1.5))':sample_rate=44100:duration=7200" \
  -ac 2 -b:a 64k "$DEST_DIR/fixture_2h_stereo.mp3"

echo "All audio fixtures generated successfully in $DEST_DIR!"
ls -lh "$DEST_DIR"
