#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>

@interface RNWaveform : NSObject <RCTBridgeModule>
@end

@implementation RNWaveform
RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }

RCT_REMAP_METHOD(getDurationSeconds,
                 getDurationSeconds:(NSString *)path
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSURL *url = [path hasPrefix:@"file://"] ? [NSURL URLWithString:path] : [NSURL fileURLWithPath:path];
    NSError *error = nil;
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:url error:&error];
    if (!file || file.processingFormat.sampleRate <= 0) {
      reject(@"AUDIO_DURATION", @"Could not read audio duration", error);
      return;
    }
    resolve(@((double)file.length / file.processingFormat.sampleRate));
  });
}
RCT_REMAP_METHOD(getWaveform,
                 getWaveform:(NSString *)path
                 count:(NSInteger)count
                 quick:(BOOL)quick
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  if (count < 8 || count > 128) {
    reject(@"AUDIO_WAVEFORM", @"Invalid waveform resolution", nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @autoreleasepool {
      NSURL *url = [path hasPrefix:@"file://"] ? [NSURL URLWithString:path] : [NSURL fileURLWithPath:path];
      NSError *error = nil;
      AVAudioFile *file = [[AVAudioFile alloc] initForReading:url commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&error];
      if (!file || file.length <= 0) {
        reject(@"AUDIO_WAVEFORM", @"Could not open audio", error);
        return;
      }
      // Perceptual loudness per bar: decode the whole file, measure 20ms
      // slices in dB, and average those per bar, so pauses pull a bar down the
      // way they sound. Returned on 0..1 where 0 = -80 dBFS and 1 = 0 dBFS.
      // Runs once per file; callers are expected to cache the result.
      const double floorDb = -80.0;
      const double sampleRate = file.processingFormat.sampleRate;
      const AVAudioChannelCount channels = file.processingFormat.channelCount;
      const AVAudioFramePosition length = file.length;
      const AVAudioFrameCount chunk = 8192;
      const long long sliceSize = MAX(1, (long long)(sampleRate * 0.02));
      AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat frameCapacity:chunk];
      double *dbSums = (double *)calloc((size_t)count, sizeof(double));
      int *slices = (int *)calloc((size_t)count, sizeof(int));
      if (!dbSums || !slices || !buffer) {
        free(dbSums);
        free(slices);
        reject(@"AUDIO_WAVEFORM", @"Out of memory", nil);
        return;
      }
      // Close-up track for the scrubber view: one value per 100ms,
      // from the same pass (full mode only).
      const NSInteger detailCount = quick ? 0 : MAX(1, (NSInteger)ceil((double)length / (sampleRate * 0.1)));
      double *detailSums = quick ? NULL : (double *)calloc((size_t)detailCount, sizeof(double));
      int *detailSlices = quick ? NULL : (int *)calloc((size_t)detailCount, sizeof(int));
      if (!quick && (!detailSums || !detailSlices)) {
        free(dbSums); free(slices); free(detailSums); free(detailSlices);
        reject(@"AUDIO_WAVEFORM", @"Out of memory", nil);
        return;
      }
      // Quick mode: a 200ms window at each bar's position (shown immediately,
      // never stored). Full mode: the whole file, so each bar covers its span.
      const AVAudioFramePosition quickWindow = (AVAudioFramePosition)(sampleRate * 0.2);
      BOOL failed = NO;
      for (NSInteger pass = 0; pass < (quick ? count : 1) && !failed; pass++) {
        AVAudioFramePosition start = 0;
        AVAudioFramePosition end = length;
        if (quick) {
          AVAudioFramePosition center = (AVAudioFramePosition)(((double)pass + 0.5) / count * length);
          start = MAX(0, center - quickWindow / 2);
          end = MIN(length, start + quickWindow);
        }
        file.framePosition = start;
        double sliceEnergy = 0;
        long long sliceFrames = 0;
        AVAudioFramePosition sliceStart = start;
        AVAudioFramePosition position = start;
        while (position < end) {
          AVAudioFrameCount wanted = (AVAudioFrameCount)MIN((AVAudioFramePosition)chunk, end - position);
          if (![file readIntoBuffer:buffer frameCount:wanted error:&error] || !buffer.floatChannelData) {
            failed = YES;
            break;
          }
          if (buffer.frameLength == 0) break;
          for (AVAudioFrameCount frame = 0; frame < buffer.frameLength; frame++) {
            if (sliceFrames == 0) sliceStart = position + frame;
            double energy = 0;
            for (AVAudioChannelCount channel = 0; channel < channels; channel++) {
              float sample = buffer.floatChannelData[channel][frame];
              if (isfinite(sample)) energy += (double)sample * sample;
            }
            sliceEnergy += energy / channels;
            if (++sliceFrames >= sliceSize) {
              double rms = sqrt(sliceEnergy / sliceFrames);
              double db = rms > 0 ? fmax(floorDb, 20 * log10(rms)) : floorDb;
              NSInteger bin = quick ? pass : MIN(count - 1, (NSInteger)((double)sliceStart / length * count));
              dbSums[bin] += db;
              slices[bin]++;
              if (!quick) {
                NSInteger detailBin = MIN(detailCount - 1, (NSInteger)((double)sliceStart / (sampleRate * 0.1)));
                detailSums[detailBin] += db;
                detailSlices[detailBin]++;
              }
              sliceEnergy = 0;
              sliceFrames = 0;
            }
          }
          position += buffer.frameLength;
        }
      }
      if (failed) {
        free(dbSums);
        free(slices);
        free(detailSums);
        free(detailSlices);
        reject(@"AUDIO_WAVEFORM", @"Could not decode audio", error);
        return;
      }
      NSMutableArray<NSNumber *> *overview = [NSMutableArray arrayWithCapacity:count];
      for (NSInteger i = 0; i < count; i++) {
        double value = slices[i] > 0 ? ((dbSums[i] / slices[i]) - floorDb) / -floorDb : 0.0;
        [overview addObject:@(fmin(1.0, fmax(0.0, value)))];
      }
      NSMutableArray<NSNumber *> *detail = [NSMutableArray arrayWithCapacity:detailCount];
      for (NSInteger i = 0; i < detailCount; i++) {
        double value = detailSlices[i] > 0 ? ((detailSums[i] / detailSlices[i]) - floorDb) / -floorDb : 0.0;
        [detail addObject:@(fmin(1.0, fmax(0.0, value)))];
      }
      free(dbSums);
      free(slices);
      free(detailSums);
      free(detailSlices);
      resolve(@{ @"overview": overview, @"detail": detail, @"detailMs": @100 });
    }
  });
}
@end
