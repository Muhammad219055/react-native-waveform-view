package com.rnwaveform

import android.media.MediaMetadataRetriever
import android.net.Uri
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future

class RNWaveformModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val durationExecutor = Executors.newSingleThreadExecutor()

  // Full decodes are long; quick previews get their own pool so a screen
  // opening never waits behind a background decode of another file.
  //
  // A small pool, not one thread: a decode that hasn't timed out shouldn't
  // fully block a second, unrelated one either. Decode is latency-bound —
  // mostly waiting on the codec process, not running — so concurrent decodes
  // overlap their waits rather than fight over cores: three at once each
  // measured ~2x slower, not a pileup (docs/Research-decode-latency.md).
  private val waveformExecutor = Executors.newFixedThreadPool(2)
  private val quickWaveformExecutor = Executors.newSingleThreadExecutor()

  // The in-flight Future for each (path, quick, count) request, so a caller
  // that has given up (e.g. its own timeout) can actually stop the decode —
  // see cancelWaveform. Without this, a timeout only stops the JS side from
  // waiting: the native decode keeps running on its executor thread and
  // blocks every decode requested after it until it finishes on its own,
  // sometimes minutes later.
  private val inFlight = ConcurrentHashMap<String, Future<*>>()

  override fun getName() = NAME

  @ReactMethod
  fun getDurationSeconds(path: String, promise: Promise) {
    durationExecutor.execute {
      val retriever = MediaMetadataRetriever()
      try {
        if (path.startsWith("content://") || path.startsWith("file://")) {
          retriever.setDataSource(context, Uri.parse(path))
        } else {
          retriever.setDataSource(path)
        }
        val milliseconds = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull()
        if (milliseconds == null || milliseconds <= 0) {
          promise.reject("AUDIO_DURATION", "Audio duration is unavailable")
        } else {
          promise.resolve(milliseconds / 1000.0)
        }
      } catch (error: Exception) {
        promise.reject("AUDIO_DURATION", "Could not read audio duration", error)
      } finally {
        retriever.release()
      }
    }
  }

  @ReactMethod
  fun getWaveform(path: String, count: Int, quick: Boolean, promise: Promise) {
    if (count !in 8..128) {
      promise.reject("AUDIO_WAVEFORM", "Invalid waveform resolution")
      return
    }
    val key = requestKey(path, quick, count)
    val future = (if (quick) quickWaveformExecutor else waveformExecutor).submit {
      if (!quick) android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
      try {
        val result = Arguments.createMap()
        val overview = Arguments.createArray()
        val detail = Arguments.createArray()
        if (quick) {
          AudioWaveform.readQuick(context, path, count).forEach { overview.pushDouble(it) }
        } else {
          val levels = AudioWaveform.read(context, path, count)
          levels.overview.forEach { overview.pushDouble(it) }
          levels.detail.forEach { detail.pushDouble(it) }
        }
        result.putArray("overview", overview)
        result.putArray("detail", detail)
        result.putDouble("detailMs", AudioWaveform.DETAIL_US / 1000.0)
        promise.resolve(result)
      } catch (error: Exception) {
        // Includes the InterruptedException a cancelWaveform() call causes:
        // the caller has already moved on by then, so this reject is a no-op.
        promise.reject("AUDIO_WAVEFORM", "Could not decode audio waveform", error)
      } finally {
        inFlight.remove(key)
      }
    }
    inFlight[key] = future
  }

  /**
   * Stops a decode the caller has given up on (its own timeout), so it
   * releases its executor thread instead of blocking every decode requested
   * after it. A no-op if the decode already finished.
   */
  @ReactMethod
  fun cancelWaveform(path: String, count: Int, quick: Boolean) {
    inFlight.remove(requestKey(path, quick, count))?.cancel(true)
  }

  private fun requestKey(path: String, quick: Boolean, count: Int) = "$path::$quick::$count"

  override fun invalidate() {
    waveformExecutor.shutdownNow()
    quickWaveformExecutor.shutdownNow()
    durationExecutor.shutdown()
    super.invalidate()
  }

  companion object {
    const val NAME = "RNWaveform"
  }
}

class RNWaveformPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
    listOf(RNWaveformModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
