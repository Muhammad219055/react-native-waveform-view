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
import java.util.concurrent.Executors

class RNWaveformModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val durationExecutor = Executors.newSingleThreadExecutor()

  // Full decodes are long; quick previews get their own thread so a screen
  // opening never waits behind a background decode of another file.
  private val waveformExecutor = Executors.newSingleThreadExecutor()
  private val quickWaveformExecutor = Executors.newSingleThreadExecutor()

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
    (if (quick) quickWaveformExecutor else waveformExecutor).execute {
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
        promise.reject("AUDIO_WAVEFORM", "Could not decode audio waveform", error)
      }
    }
  }

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
