# Decode benchmark harness

Runs the library's decode loop directly on an Android device — no app, no React
Native — so decoder throughput can be measured in isolation.

```sh
SDK=~/Library/Android/sdk
javac -nowarn -cp $SDK/platforms/android-36/android.jar -d classes Bench.java
$SDK/build-tools/36.0.0/d8 --release --lib $SDK/platforms/android-36/android.jar --output . classes/*.class
adb push classes.dex /data/local/tmp/bench.dex

# <path> <segments> <nice> <math 0|1> [quick]
adb shell "CLASSPATH=/data/local/tmp/bench.dex app_process /system/bin Bench /data/local/tmp/file.mp3 4 0 1"
```

Prints wall time, CPU time, sample count, the codec actually selected, and the
throughput as a multiple of real time. Wall ≫ CPU means the decode is blocked on
IPC with the codec process, not doing work.

Generate test files with:

```sh
ffmpeg -f lavfi -i "sine=frequency=220:duration=180" -ar 44100 -b:a 128k bench180.mp3
```
