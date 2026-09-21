import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Debug;
import android.os.Process;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Standalone on-device benchmark of the waveform decode path.
 *
 * Runs the same MediaExtractor + MediaCodec + 20ms-slice loudness loop the
 * library uses, with no app and no React Native, so the decoder can be measured
 * in isolation.
 *
 * Usage: Bench <path> <segments> <nice> <math 0|1>
 * Prints: RESULT segments=.. nice=.. math=.. wallMs=.. cpuMs=.. samples=.. codec=.. xRealtime=..
 */
public class Bench {
  static final int SLICE_MS = 20;
  static final double FLOOR_DB = -80.0;
  static final int IDLE_LIMIT = 200;

  public static void main(String[] args) throws Exception {
    String path = args[0];
    int segments = Integer.parseInt(args[1]);
    int nice = Integer.parseInt(args[2]);
    final boolean math = Integer.parseInt(args[3]) != 0;
    // args[4]: "quick" runs the sampled pass (one 200ms window per bar, 64 bars).
    final boolean quick = args.length > 4 && args[4].equals("quick");

    long durationUs;
    String codecName;
    Source probe = new Source(path);
    try {
      durationUs = probe.durationUs;
      codecName = probe.codecName;
    } finally {
      probe.close();
    }

    final long[] cpuNanos = new long[segments];
    final long[] sampleCounts = new long[segments];
    final Throwable[] errors = new Throwable[segments];
    final long total = durationUs;
    final int segs = segments;
    final int niceValue = nice;

    long wallStart = System.nanoTime();
    if (quick) {
      Source source = new Source(path);
      long cpuStart = Debug.threadCpuTimeNanos();
      long frames = 0;
      int bars = 64;
      for (int bin = 0; bin < bars; bin++) {
        long center = (long) ((bin + 0.5) * durationUs / bars);
        long start = Math.max(0, center - 100_000L);
        source.seek(start);
        frames += source.decode(start + 200_000L, math);
      }
      long qCpu = (Debug.threadCpuTimeNanos() - cpuStart) / 1_000_000L;
      source.close();
      long qWall = (System.nanoTime() - wallStart) / 1_000_000L;
      System.out.println("RESULT mode=quick bars=" + bars + " wallMs=" + qWall + " cpuMs=" + qCpu
          + " samples=" + frames + " codec=" + codecName + " durationMs=" + (durationUs / 1000));
      return;
    }
    List<Thread> threads = new ArrayList<>();
    for (int s = 0; s < segments; s++) {
      final int segment = s;
      Thread t = new Thread(() -> {
        Process.setThreadPriority(niceValue);
        long cpuStart = Debug.threadCpuTimeNanos();
        try {
          long start = total * segment / segs;
          long end = segment == segs - 1 ? Long.MAX_VALUE : total * (segment + 1) / segs;
          Source source = new Source(path);
          try {
            if (start > 0) source.seek(start);
            sampleCounts[segment] = source.decode(end, math);
          } finally {
            source.close();
          }
        } catch (Throwable e) {
          errors[segment] = e;
        }
        cpuNanos[segment] = Debug.threadCpuTimeNanos() - cpuStart;
      });
      threads.add(t);
      t.start();
    }
    for (Thread t : threads) t.join();
    long wallMs = (System.nanoTime() - wallStart) / 1_000_000L;

    for (Throwable e : errors) {
      if (e != null) {
        System.out.println("ERROR " + e);
        return;
      }
    }
    long cpuMs = 0;
    long samples = 0;
    for (int i = 0; i < segments; i++) {
      cpuMs += cpuNanos[i] / 1_000_000L;
      samples += sampleCounts[i];
    }
    double xRealtime = (durationUs / 1000.0) / Math.max(1, wallMs);
    System.out.println("RESULT segments=" + segments + " nice=" + nice + " math=" + (math ? 1 : 0)
        + " wallMs=" + wallMs + " cpuMs=" + cpuMs + " samples=" + samples
        + " codec=" + codecName + " durationMs=" + (durationUs / 1000)
        + " xRealtime=" + String.format("%.1f", xRealtime));
  }

  /** One extractor + decoder over the file's audio track. */
  static class Source {
    final MediaExtractor extractor = new MediaExtractor();
    final MediaCodec codec;
    final long durationUs;
    final String codecName;
    int rate;
    int channels;
    boolean floatPcm = false;
    boolean inputEnded = false;

    Source(String path) throws Exception {
      extractor.setDataSource(path);
      int track = -1;
      for (int i = 0; i < extractor.getTrackCount(); i++) {
        String mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
        if (mime != null && mime.startsWith("audio/")) { track = i; break; }
      }
      if (track < 0) throw new IllegalStateException("No audio track");
      extractor.selectTrack(track);
      MediaFormat format = extractor.getTrackFormat(track);
      codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
      codec.configure(format, null, null, 0);
      codec.start();
      codecName = codec.getName();
      rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
      channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
      durationUs = format.getLong(MediaFormat.KEY_DURATION);
    }

    void seek(long us) {
      extractor.seekTo(us, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
      codec.flush();
      inputEnded = false;
    }

    /** Decodes to endUs, returning the number of PCM frames seen. */
    long decode(long endUs, boolean math) throws Exception {
      MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
      double sliceEnergy = 0;
      int sliceFrames = 0;
      long frames = 0;
      int idle = 0;
      while (idle < IDLE_LIMIT) {
        while (!inputEnded) {
          int index = codec.dequeueInputBuffer(0);
          if (index < 0) break;
          int size = extractor.readSampleData(codec.getInputBuffer(index), 0);
          if (size < 0) {
            codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            inputEnded = true;
          } else {
            codec.queueInputBuffer(index, 0, size, extractor.getSampleTime(), 0);
            extractor.advance();
          }
        }
        int index = codec.dequeueOutputBuffer(info, 5_000);
        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          MediaFormat output = codec.getOutputFormat();
          rate = output.getInteger(MediaFormat.KEY_SAMPLE_RATE);
          channels = output.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
          if (output.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
            floatPcm = output.getInteger(MediaFormat.KEY_PCM_ENCODING) == 4; // ENCODING_PCM_FLOAT
          }
          continue;
        }
        if (index < 0) { idle++; continue; }
        idle = 0;
        boolean ended = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
        long bufferStartUs = info.presentationTimeUs;
        try {
          ByteBuffer buffer = codec.getOutputBuffer(index).order(ByteOrder.LITTLE_ENDIAN);
          buffer.position(info.offset);
          buffer.limit(info.offset + info.size);
          int sliceSize = Math.max(1, rate * SLICE_MS / 1000);
          if (!math) {
            frames += (info.size / 2) / Math.max(1, channels);
          } else if (floatPcm) {
            java.nio.FloatBuffer samples = buffer.asFloatBuffer();
            int frameCount = samples.remaining() / channels;
            for (int frame = 0; frame < frameCount; frame++) {
              double energy = 0;
              for (int c = 0; c < channels; c++) {
                double v = samples.get();
                if (!Double.isInfinite(v) && !Double.isNaN(v)) energy += v * v;
              }
              sliceEnergy += energy / channels;
              if (++sliceFrames >= sliceSize) { sliceEnergy = 0; sliceFrames = 0; }
            }
            frames += frameCount;
          } else {
            ShortBuffer shortBuffer = buffer.asShortBuffer();
            short[] samples = new short[shortBuffer.remaining()];
            shortBuffer.get(samples);
            int frameCount = samples.length / channels;
            double scale = 1.0 / (32768.0 * 32768.0 * channels);
            int i = 0;
            for (int frame = 0; frame < frameCount; frame++) {
              long energy = 0;
              for (int c = 0; c < channels; c++) {
                long v = samples[i++];
                energy += v * v;
              }
              sliceEnergy += energy * scale;
              if (++sliceFrames >= sliceSize) { sliceEnergy = 0; sliceFrames = 0; }
            }
            frames += frameCount;
          }
        } finally {
          codec.releaseOutputBuffer(index, false);
        }
        if (ended || bufferStartUs >= endUs) break;
      }
      return frames;
    }

    void close() {
      codec.release();
      extractor.release();
    }
  }
}
