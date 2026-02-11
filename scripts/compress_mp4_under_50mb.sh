#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/compress_mp4_under_50mb.sh <input_video_path> <output_video_path>

Description:
  Compresses one video to under 5MB and writes to <output_video_path>.

Notes:
  - Uses H.264 (libx264) + AAC encoding.
  - Tries multiple bitrate passes until size <= 5MB.
  - If the output still cannot be reduced under 5MB after retries, the
    smallest generated version is written to <output_video_path> and reported
    as failed.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 2 ]]; then
  usage
  exit 0
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg is not installed or not in PATH." >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "Error: ffprobe is not installed or not in PATH." >&2
  exit 1
fi

input_video="$1"
output_video="$2"

if [[ ! -f "$input_video" ]]; then
  echo "Error: input file does not exist: $input_video" >&2
  exit 1
fi

output_dir="$(dirname "$output_video")"
if [[ ! -d "$output_dir" ]]; then
  echo "Error: output directory does not exist: $output_dir" >&2
  exit 1
fi

TARGET_MB=5
TARGET_BYTES=$((TARGET_MB * 1024 * 1024))
MAX_ATTEMPTS=8
DEFAULT_AUDIO_KBPS=64
MIN_VIDEO_KBPS=40

get_file_size() {
  local f="$1"
  if stat -f%z "$f" >/dev/null 2>&1; then
    stat -f%z "$f"
  else
    stat -c%s "$f"
  fi
}

has_audio_stream() {
  local f="$1"
  local out
  out="$(ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "$f" | head -n1 || true)"
  [[ -n "$out" ]]
}

compress_one() {
  local input_path="$1"
  local output_path="$2"
  local original_size duration total_kbps audio_kbps video_kbps attempt
  local tmp output_size best_tmp best_size has_audio=0

  original_size="$(get_file_size "$input_path")"
  if (( original_size <= TARGET_BYTES )); then
    if [[ "$input_path" != "$output_path" ]]; then
      cp -f "$input_path" "$output_path"
    fi
    echo "Skip (already <= ${TARGET_MB}MB): $input_path"
    return 0
  fi

  duration="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$input_path" | head -n1)"
  if [[ -z "$duration" ]]; then
    echo "Fail (no duration): $input_path" >&2
    return 1
  fi

  total_kbps="$(awk -v t="$TARGET_BYTES" -v d="$duration" 'BEGIN { if (d <= 0) print 300; else print int((t * 8 / d) / 1000) }')"
  if has_audio_stream "$input_path"; then
    has_audio=1
    audio_kbps="$DEFAULT_AUDIO_KBPS"
  else
    audio_kbps=0
  fi

  video_kbps=$((total_kbps - audio_kbps - 16))
  if (( video_kbps < MIN_VIDEO_KBPS )); then
    video_kbps="$MIN_VIDEO_KBPS"
  fi

  best_tmp=""
  best_size=0

  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    tmp="$(mktemp "${TMPDIR:-/tmp}/compress_under5mb.${attempt}.XXXXXX.mp4")"

    cmd=(ffmpeg -nostdin -y -hide_banner -loglevel error -i "$input_path" -map 0:v:0 -map_metadata -1
      -c:v libx264 -preset medium -pix_fmt yuv420p
      -b:v "${video_kbps}k" -maxrate "${video_kbps}k" -bufsize "$((video_kbps * 2))k")

    if (( has_audio == 1 )); then
      cmd+=(-map 0:a:0 -c:a aac -b:a "${audio_kbps}k" -ac 2)
    else
      cmd+=(-an)
    fi

    cmd+=(-movflags +faststart "$tmp")

    if ! "${cmd[@]}"; then
      rm -f "$tmp"
      video_kbps=$((video_kbps * 82 / 100))
      if (( video_kbps < MIN_VIDEO_KBPS )); then
        video_kbps=MIN_VIDEO_KBPS
      fi
      continue
    fi

    output_size="$(get_file_size "$tmp")"
    if [[ -z "$best_tmp" || "$output_size" -lt "$best_size" ]]; then
      if [[ -n "$best_tmp" ]]; then
        rm -f "$best_tmp"
      fi
      best_tmp="$tmp"
      best_size="$output_size"
    else
      rm -f "$tmp"
    fi

    if (( output_size <= TARGET_BYTES )); then
      mv -f "$best_tmp" "$output_path"
      echo "OK   $input_path -> $output_path ($(awk -v s="$original_size" 'BEGIN { printf "%.1f", s/1024/1024 }')MB -> $(awk -v s="$output_size" 'BEGIN { printf "%.1f", s/1024/1024 }')MB)"
      return 0
    fi

    video_kbps=$((video_kbps * 82 / 100))
    if (( video_kbps < MIN_VIDEO_KBPS )); then
      video_kbps=MIN_VIDEO_KBPS
    fi
  done

  if [[ -n "$best_tmp" ]]; then
    mv -f "$best_tmp" "$output_path"
    output_size="$(get_file_size "$output_path")"
    echo "FAIL $input_path -> $output_path ($(awk -v s="$output_size" 'BEGIN { printf "%.1f", s/1024/1024 }')MB, still > ${TARGET_MB}MB)" >&2
  else
    echo "FAIL $input_path (no output generated)" >&2
  fi

  return 1
}

compress_one "$input_video" "$output_video"
