#!/bin/sh
# Regenerates fixtures/ from FFmpeg synthetic sources (no third-party content, so redistributable).
# The committed files are the source of truth; run this only to rebuild them.
set -eu
cd "$(dirname "$0")/../../fixtures"

img() { # name size color
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=$2:rate=1" -frames:v 1 "$1"
}
img sample-1.png 320x240
img sample-2.jpg 640x360
img sample-3.webp 400x400
img sample-4.png 800x600
img sample-5.jpg 1280x720

# 3 second, 320x180 H.264 clip with a sine tone
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x180:rate=15:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart sample.mp4

# Corrupt files: valid header, truncated body; and text pretending to be a PNG
head -c 600 sample-1.png > corrupt.png
head -c 4000 sample.mp4 > corrupt.mp4
echo "this is not an image" > fake.png

# 60 second low-res clip: exercises more than one sprite sheet
ffmpeg -v error -y -f lavfi -i "testsrc2=size=160x90:rate=5:duration=60" \
  -c:v libx264 -pix_fmt yuv420p -crf 35 -an -movflags +faststart sample-long.mp4
