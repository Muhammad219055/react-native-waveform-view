package com.rnwaveform

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Perceptual loudness envelope for an audio file, as [count] bars on a 0..1
 * scale where 0 = -80 dBFS and 1 = 0 dBFS.
 *
 * Loudness is measured per 20ms slice in dB and averaged per bar: averaging
 * raw energy lets loud syllables dominate and hides pauses between sentences.
 *
 * Two modes, because the platform decoder is the bottleneck — not on compute,
 * but on IPC latency to the codec process: a single decode thread spends most
 * of its time (measured ~85%) blocked on `dequeueOutputBuffer`, not running,
 * so throughput scales by overlapping waits across threads rather than by
 * spreading CPU work (measured: 1 segment ~29x real time, 4 segments ~78x, on
 * one 3-minute file — see Research-decode-latency.md in the repo root):
 *  - [readQuick]: decodes a 200ms window at each bar's position. About a
 *    second even for hour-long files; shown immediately, never stored.
 *  - [read]: decodes the whole file, split across parallel decoders on
 *    separate cores, so every bar reflects its full time span. Also yields a
 *    close-up track (one value per 100ms) for the scrolling player view,
 *    from the same pass at no extra decode cost. Stored.
 */
object AudioWaveform {
  private const val SLICE_MS = 20
  private const val FLOOR_DB = -80.0
  private const val IDLE_LIMIT = 200
  private const val QUICK_WINDOW_US = 200_000L
  private const val MIN_SEGMENT_US = 30_000_000L
  const val DETAIL_US = 100_000L

  /** Whole-file overview plus a close-up track at [DETAIL_US] per bar. */
  class Result(val overview: DoubleArray, val detail: DoubleArray)

  fun read(context: Context, path: String, count: Int): Result {
    val durationUs = Source(context, path).use { it.durationUs }
    val detailCount = ((durationUs + DETAIL_US - 1) / DETAIL_US).toInt().coerceAtLeast(1)
    // Each decoder owns its own accumulators (summed afterwards), so the
    // parallel segments never write shared memory.
    //
    // The cap is `cores`, not `cores - 1`: segment threads spend most of
    // their time blocked on the codec process, not running, so they are not
    // competing with the rest of the app for CPU the way a compute-bound
    // thread would. Reserving a core for "everything else" measured as a
    // 1.6x loss (2 segments instead of 4 on a 4-core device) for no
    // measurable smoothness gain. Going past 4 measured worse (thread
    // contention with only 4 cores to actually overlap on), so the ceiling
    // stays at the highest option below.
    val cores = Runtime.getRuntime().availableProcessors()
    val segments = listOf(4, 2, 1).first { it <= max(1, cores) && durationUs / it >= MIN_SEGMENT_US || it == 1 }
    val sums = Array(segments) { DoubleArray(count) }
    val slices = Array(segments) { IntArray(count) }
    val detailSums = Array(segments) { DoubleArray(detailCount) }
    val detailSlices = Array(segments) { IntArray(detailCount) }
    val errors = arrayOfNulls<Throwable>(segments)
    val threads = (0 until segments).map { segment ->
      Thread {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
        try {
          val start = durationUs * segment / segments
          val end = if (segment == segments - 1) Long.MAX_VALUE else durationUs * (segment + 1) / segments
          Source(context, path).use { source ->
            if (start > 0) source.seek(start)
            source.decode(end) { sliceUs, db ->
              if (sliceUs >= start && sliceUs < end) {
                val bin = (sliceUs.toDouble() / durationUs * count).toInt().coerceIn(0, count - 1)
                sums[segment][bin] += db
                slices[segment][bin]++
                val detailBin = (sliceUs / DETAIL_US).toInt().coerceIn(0, detailCount - 1)
                detailSums[segment][detailBin] += db
                detailSlices[segment][detailBin]++
              }
            }
          }
        } catch (error: Throwable) {
          errors[segment] = error
        }
      }.also { it.start() }
    }
    try {
      threads.forEach { it.join() }
    } catch (interrupted: InterruptedException) {
      threads.forEach { it.interrupt() }
      throw interrupted
    }
    errors.firstOrNull { it != null }?.let { throw it }
    fun average(total: Array<DoubleArray>, n: Array<IntArray>, size: Int) = DoubleArray(size) { bin ->
      val slicesInBin = n.sumOf { it[bin] }
      if (slicesInBin > 0) (total.sumOf { it[bin] } / slicesInBin - FLOOR_DB) / -FLOOR_DB else 0.0
    }
    return Result(average(sums, slices, count), average(detailSums, detailSlices, detailCount))
  }

  fun readQuick(context: Context, path: String, count: Int): DoubleArray {
    val sums = DoubleArray(count)
    val slices = IntArray(count)
    Source(context, path).use { source ->
      for (bin in 0 until count) {
        val center = ((bin + 0.5) * source.durationUs / count).toLong()
        val start = max(0L, center - QUICK_WINDOW_US / 2)
        val end = start + QUICK_WINDOW_US
        source.seek(start)
        source.decode(end) { sliceUs, db ->
          if (sliceUs >= start && sliceUs < end) {
            sums[bin] += db
            slices[bin]++
          }
        }
      }
    }
    return DoubleArray(count) { if (slices[it] > 0) (sums[it] / slices[it] - FLOOR_DB) / -FLOOR_DB else 0.0 }
  }

  /** One extractor + decoder over the file's audio track. */
  private class Source(context: Context, path: String) : AutoCloseable {
    private val extractor = MediaExtractor()
    private val codec: MediaCodec
    val durationUs: Long
    private var rate: Int
    private var channels: Int
    private var floatPcm = false
    private var inputEnded = false

    init {
      var created: MediaCodec? = null
      var trackFormat: MediaFormat? = null
      try {
        if (path.startsWith("content://") || path.startsWith("file://")) {
          extractor.setDataSource(context, Uri.parse(path), null)
        } else {
          extractor.setDataSource(path)
        }
        val track = (0 until extractor.trackCount).firstOrNull {
          extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: error("No audio track")
        extractor.selectTrack(track)
        val format = extractor.getTrackFormat(track)
        trackFormat = format
        created = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
        created.configure(format, null, null, 0)
        created.start()
      } catch (error: Throwable) {
        created?.release()
        extractor.release()
        throw error
      }
      val format = trackFormat!!
      codec = created!!
      rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      // Some containers (e.g. streamed WebM) omit the track duration.
      durationUs =
        if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION)
        else retrieverDurationUs(context, path)
      if (durationUs <= 0) {
        close()
        error("Audio duration unavailable")
      }
    }

    fun seek(us: Long) {
      extractor.seekTo(us, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
      codec.flush()
      inputEnded = false
    }

    /** Decodes until output reaches [endUs] or the stream ends, reporting each 20ms slice's start and dB. */
    fun decode(endUs: Long, onSlice: (sliceUs: Long, db: Double) -> Unit) {
      val info = MediaCodec.BufferInfo()
      var sliceEnergy = 0.0
      var sliceFrames = 0
      var sliceStartUs = 0L
      fun flushSlice() {
        if (sliceFrames == 0) return
        val rms = sqrt(sliceEnergy / sliceFrames)
        onSlice(sliceStartUs, if (rms > 0) max(FLOOR_DB, 20 * log10(rms)) else FLOOR_DB)
        sliceEnergy = 0.0
        sliceFrames = 0
      }
      var idle = 0
      while (idle < IDLE_LIMIT) {
        if (Thread.currentThread().isInterrupted) throw InterruptedException("Waveform cancelled")
        // Keep the decoder's input queue full rather than one frame per pass.
        while (!inputEnded) {
          val index = codec.dequeueInputBuffer(0)
          if (index < 0) break
          val size = extractor.readSampleData(codec.getInputBuffer(index)!!, 0)
          if (size < 0) {
            codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            inputEnded = true
          } else {
            codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
            extractor.advance()
          }
        }
        val index = codec.dequeueOutputBuffer(info, 5_000)
        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val output = codec.outputFormat
          rate = output.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          channels = output.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          val encoding =
            if (output.containsKey(MediaFormat.KEY_PCM_ENCODING)) output.getInteger(MediaFormat.KEY_PCM_ENCODING)
            else AudioFormat.ENCODING_PCM_16BIT
          require(encoding == AudioFormat.ENCODING_PCM_16BIT || encoding == AudioFormat.ENCODING_PCM_FLOAT) {
            "Unsupported decoded PCM format"
          }
          floatPcm = encoding == AudioFormat.ENCODING_PCM_FLOAT
          continue
        }
        if (index < 0) {
          idle++
          continue
        }
        idle = 0
        val ended = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
        val bufferStartUs = info.presentationTimeUs
        try {
          val buffer = codec.getOutputBuffer(index)!!.order(ByteOrder.LITTLE_ENDIAN)
          buffer.position(info.offset)
          buffer.limit(info.offset + info.size)
          val sliceSize = max(1, rate * SLICE_MS / 1000)
          if (floatPcm) {
            val samples = buffer.asFloatBuffer()
            val frameCount = samples.remaining() / channels
            for (frame in 0 until frameCount) {
              if (sliceFrames == 0) sliceStartUs = bufferStartUs + frame * 1_000_000L / rate
              var energy = 0.0
              for (c in 0 until channels) {
                val v = samples.get().toDouble()
                if (v.isFinite()) energy += v * v
              }
              sliceEnergy += energy / channels
              if (++sliceFrames >= sliceSize) flushSlice()
            }
          } else {
            val shortBuffer = buffer.asShortBuffer()
            val samples = ShortArray(shortBuffer.remaining())
            shortBuffer.get(samples)
            val frameCount = samples.size / channels
            val scale = 1.0 / (32768.0 * 32768.0 * channels)
            var i = 0
            for (frame in 0 until frameCount) {
              if (sliceFrames == 0) sliceStartUs = bufferStartUs + frame * 1_000_000L / rate
              var energy = 0L
              for (c in 0 until channels) {
                val v = samples[i++].toLong()
                energy += v * v
              }
              sliceEnergy += energy * scale
              if (++sliceFrames >= sliceSize) flushSlice()
            }
          }
        } finally {
          codec.releaseOutputBuffer(index, false)
        }
        if (ended || bufferStartUs >= endUs) break
      }
      flushSlice()
    }

    override fun close() {
      codec.release()
      extractor.release()
    }
  }

  private fun retrieverDurationUs(context: Context, path: String): Long {
    val retriever = MediaMetadataRetriever()
    return try {
      if (path.startsWith("content://") || path.startsWith("file://")) {
        retriever.setDataSource(context, Uri.parse(path))
      } else {
        retriever.setDataSource(path)
      }
      (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) * 1000L
    } finally {
      retriever.release()
    }
  }
}
