#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/compress_mp4.sh <input_video_path> <output_video_path>

Description:
  Compresses one homepage preview video with a two-stage pipeline:
    1. Build a web-quality reference around REFERENCE_TARGET_MB, default 5MB.
    2. Run dynamic CRF compression and choose the smallest final encode whose
       sampled SSIM against that reference is at least QUALITY_SSIM.

Environment options:
  REFERENCE_TARGET_MB=5    Stage-1 reference size cap. TARGET_MB also works.
  REFERENCE_FILL_RATIO=0.98
                            Leave muxing headroom below REFERENCE_TARGET_MB.
  QUALITY_SSIM=0.982       Minimum sampled SSIM against the stage-1 reference.
  CRF_CANDIDATES="34 32 30 28 26"
                            Tried from smallest/lossiest to largest/cleanest.
  FORCE_REFERENCE=0        Rebuild the stage-1 reference even if input is small.
  MAX_WIDTH=960            Downscale wider videos to this width. Set 0 to keep.
  MAX_FPS=30               Cap frame rate. Set 0 to keep source frame rate.
  STRIP_AUDIO=1            Drop audio by default because homepage videos are muted.
  AUDIO_KBPS=48            AAC bitrate when STRIP_AUDIO=0 and audio exists.
  X264_PRESET=slow         libx264 preset. Use veryslow for slower/smaller tests.
  SSIM_SAMPLE_SECONDS=20   Seconds to sample for SSIM. Set 0 for full duration.
  NEVER_GROW=1             Keep the reference if the final encode would be larger.
  MAX_ATTEMPTS=5           Stage-1 retry count if muxed output exceeds target.

Notes:
  - Stage 2 compares against the 5MB-ish reference, not the raw source. This
    keeps very large masters from forcing oversized homepage preview videos.
  - Uses H.264 (libx264), yuv420p, faststart, and strips audio by default.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 2 ]]; then
  usage
  exit 0
fi

for required_cmd in ffmpeg ffprobe rg; do
  if ! command -v "$required_cmd" >/dev/null 2>&1; then
    echo "Error: $required_cmd is not installed or not in PATH." >&2
    exit 1
  fi
done

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

REFERENCE_TARGET_MB="${REFERENCE_TARGET_MB:-${TARGET_MB:-5}}"
REFERENCE_FILL_RATIO="${REFERENCE_FILL_RATIO:-0.98}"
QUALITY_SSIM="${QUALITY_SSIM:-0.982}"
CRF_CANDIDATES="${CRF_CANDIDATES:-34 32 30 28 26}"
FORCE_REFERENCE="${FORCE_REFERENCE:-0}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-5}"
MIN_VIDEO_KBPS="${MIN_VIDEO_KBPS:-40}"
MAX_WIDTH="${MAX_WIDTH:-960}"
MAX_FPS="${MAX_FPS:-30}"
STRIP_AUDIO="${STRIP_AUDIO:-1}"
AUDIO_KBPS="${AUDIO_KBPS:-48}"
X264_PRESET="${X264_PRESET:-slow}"
SSIM_SAMPLE_SECONDS="${SSIM_SAMPLE_SECONDS:-20}"
NEVER_GROW="${NEVER_GROW:-1}"

REFERENCE_TARGET_BYTES="$(awk -v mb="$REFERENCE_TARGET_MB" 'BEGIN { printf "%d", mb * 1024 * 1024 }')"
if (( REFERENCE_TARGET_BYTES <= 0 )); then
  echo "Error: REFERENCE_TARGET_MB must be greater than 0." >&2
  exit 1
fi

get_file_size() {
  local f="$1"
  if stat -f%z "$f" >/dev/null 2>&1; then
    stat -f%z "$f"
  else
    stat -c%s "$f"
  fi
}

format_mb() {
  awk -v s="$1" 'BEGIN { printf "%.2f", s / 1024 / 1024 }'
}

has_audio_stream() {
  local f="$1"
  local out
  out="$(ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "$f" | head -n1 || true)"
  [[ -n "$out" ]]
}

probe_duration() {
  ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1" | head -n1
}

probe_avg_fps() {
  local rate
  rate="$(ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of csv=p=0 "$1" | head -n1)"
  awk -F/ -v r="$rate" 'BEGIN {
    if (r == "" || r == "0/0") {
      print 0
    } else if (index(r, "/") > 0) {
      split(r, a, "/")
      if (a[2] == 0) print 0
      else printf "%.6f", a[1] / a[2]
    } else {
      printf "%.6f", r
    }
  }'
}

probe_stream_compact() {
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -of csv=p=0:s=x "$1" | head -n1
}

build_video_filter() {
  local input_path="$1"
  local fps should_cap filter=""

  if (( MAX_WIDTH > 0 )); then
    filter="scale=w='min(${MAX_WIDTH},iw)':h=-2:flags=lanczos"
  fi

  if (( MAX_FPS > 0 )); then
    fps="$(probe_avg_fps "$input_path")"
    should_cap="$(awk -v fps="$fps" -v max="$MAX_FPS" 'BEGIN { print (fps > max + 0.01) ? 1 : 0 }')"
    if [[ "$should_cap" == "1" ]]; then
      if [[ -n "$filter" ]]; then
        filter+=","
      fi
      filter+="fps=${MAX_FPS}"
    fi
  fi

  echo "$filter"
}

cleanup_passlog() {
  local passlog="$1"
  rm -f "${passlog}" "${passlog}-0.log" "${passlog}-0.log.mbtree"
}

should_keep_audio() {
  local input_path="$1"
  if [[ "$STRIP_AUDIO" != "1" ]] && has_audio_stream "$input_path"; then
    echo 1
  else
    echo 0
  fi
}

encode_two_pass_vbr() {
  local input_path="$1"
  local output_path="$2"
  local video_kbps="$3"
  local audio_kbps="$4"
  local include_audio="$5"
  local vf="$6"
  local passlog
  local -a common_args

  passlog="$(mktemp "${TMPDIR:-/tmp}/compress_reference.pass.XXXXXX")"
  rm -f "$passlog"

  common_args=(ffmpeg -nostdin -y -hide_banner -loglevel error -i "$input_path"
    -map 0:v:0 -map_metadata -1)

  if [[ -n "$vf" ]]; then
    common_args+=(-vf "$vf")
  fi

  common_args+=(-c:v libx264 -preset "$X264_PRESET" -pix_fmt yuv420p -b:v "${video_kbps}k")

  if ! "${common_args[@]}" -pass 1 -passlogfile "$passlog" -an -f null /dev/null; then
    cleanup_passlog "$passlog"
    return 1
  fi

  if (( include_audio == 1 )); then
    if ! "${common_args[@]}" -pass 2 -passlogfile "$passlog" \
      -map 0:a:0 -c:a aac -b:a "${audio_kbps}k" -ac 2 \
      -movflags +faststart "$output_path"; then
      cleanup_passlog "$passlog"
      return 1
    fi
  else
    if ! "${common_args[@]}" -pass 2 -passlogfile "$passlog" -an \
      -movflags +faststart "$output_path"; then
      cleanup_passlog "$passlog"
      return 1
    fi
  fi

  cleanup_passlog "$passlog"
}

build_reference() {
  local input_path="$1"
  local reference_path="$2"
  local input_size duration target_bytes total_kbps audio_kbps video_kbps include_audio vf
  local attempt tmp output_size best_tmp="" best_size=0

  input_size="$(get_file_size "$input_path")"

  if (( input_size <= REFERENCE_TARGET_BYTES )) && [[ "$FORCE_REFERENCE" != "1" ]]; then
    cp -f "$input_path" "$reference_path"
    echo "ref  copy $input_path -> $reference_path ($(format_mb "$input_size")MB; already <= ${REFERENCE_TARGET_MB}MB)" >&2
    return 0
  fi

  duration="$(probe_duration "$input_path")"
  if [[ -z "$duration" ]]; then
    echo "Fail (no duration): $input_path" >&2
    return 1
  fi

  include_audio="$(should_keep_audio "$input_path")"
  if (( include_audio == 1 )); then
    audio_kbps="$AUDIO_KBPS"
  else
    audio_kbps=0
  fi

  target_bytes="$(awk -v t="$REFERENCE_TARGET_BYTES" -v r="$REFERENCE_FILL_RATIO" 'BEGIN { printf "%d", t * r }')"
  total_kbps="$(awk -v t="$target_bytes" -v d="$duration" 'BEGIN { if (d <= 0) print 300; else print int((t * 8 / d) / 1000) }')"
  video_kbps=$((total_kbps - audio_kbps - 16))
  if (( video_kbps < MIN_VIDEO_KBPS )); then
    video_kbps="$MIN_VIDEO_KBPS"
  fi

  vf="$(build_video_filter "$input_path")"

  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    tmp="$(mktemp "${TMPDIR:-/tmp}/compress_reference.${attempt}.XXXXXX.mp4")"

    if ! encode_two_pass_vbr "$input_path" "$tmp" "$video_kbps" "$audio_kbps" "$include_audio" "$vf"; then
      rm -f "$tmp"
      video_kbps=$((video_kbps * 90 / 100))
      if (( video_kbps < MIN_VIDEO_KBPS )); then
        video_kbps="$MIN_VIDEO_KBPS"
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

    if (( output_size <= REFERENCE_TARGET_BYTES )); then
      mv -f "$best_tmp" "$reference_path"
      echo "ref  ok   $input_path -> $reference_path ($(format_mb "$input_size")MB -> $(format_mb "$output_size")MB, ${video_kbps}k video, vf='${vf:-none}', audio=$([[ "$include_audio" == "1" ]] && echo keep || echo strip))" >&2
      return 0
    fi

    video_kbps=$((video_kbps * 90 / 100))
    if (( video_kbps < MIN_VIDEO_KBPS )); then
      video_kbps="$MIN_VIDEO_KBPS"
    fi
  done

  if [[ -n "$best_tmp" ]]; then
    mv -f "$best_tmp" "$reference_path"
    output_size="$(get_file_size "$reference_path")"
    echo "ref  warn $input_path -> $reference_path ($(format_mb "$output_size")MB, still > ${REFERENCE_TARGET_MB}MB)" >&2
    return 0
  fi

  echo "FAIL $input_path (no reference generated)" >&2
  return 1
}

encode_crf() {
  local input_path="$1"
  local output_path="$2"
  local crf="$3"
  local include_audio="$4"
  local vf="$5"
  local -a cmd

  cmd=(ffmpeg -nostdin -y -hide_banner -loglevel error -i "$input_path"
    -map 0:v:0 -map_metadata -1)

  if [[ -n "$vf" ]]; then
    cmd+=(-vf "$vf")
  fi

  cmd+=(-c:v libx264 -preset "$X264_PRESET" -crf "$crf" -pix_fmt yuv420p)

  if (( include_audio == 1 )); then
    cmd+=(-map 0:a:0 -c:a aac -b:a "${AUDIO_KBPS}k" -ac 2)
  else
    cmd+=(-an)
  fi

  cmd+=(-movflags +faststart "$output_path")
  "${cmd[@]}"
}

measure_ssim() {
  local reference_path="$1"
  local encoded_path="$2"
  local info width height rest fps ssim
  local -a duration_args=()

  info="$(probe_stream_compact "$encoded_path")"
  width="${info%%x*}"
  rest="${info#*x}"
  height="${rest%%x*}"
  fps="${rest#*x}"

  if awk -v seconds="$SSIM_SAMPLE_SECONDS" 'BEGIN { exit !(seconds > 0) }'; then
    duration_args=(-t "$SSIM_SAMPLE_SECONDS")
  fi

  ssim="$(ffmpeg -hide_banner -nostats \
    "${duration_args[@]}" -i "$reference_path" \
    "${duration_args[@]}" -i "$encoded_path" \
    -filter_complex "[0:v]scale=${width}:${height}:flags=lanczos,fps=${fps},setpts=PTS-STARTPTS[ref];[1:v]setpts=PTS-STARTPTS[dist];[ref][dist]ssim" \
    -f null - 2>&1 | rg 'All:' | sed -E 's/.*All:([^ ]+).*/\1/')"

  if [[ -n "$ssim" ]]; then
    echo "$ssim"
  else
    echo 0
  fi
}

compress_dynamic_from_reference() {
  local reference_path="$1"
  local output_path="$2"
  local reference_size include_audio vf crf candidate candidate_size candidate_ssim
  local selected="" selected_size=0 selected_ssim=0 selected_crf=""
  local best="" best_size=0 best_ssim=0 best_crf=""

  reference_size="$(get_file_size "$reference_path")"
  include_audio="$(should_keep_audio "$reference_path")"
  vf="$(build_video_filter "$reference_path")"

  for crf in $CRF_CANDIDATES; do
    candidate="$tmp_dir/candidate-crf${crf}.mp4"
    encode_crf "$reference_path" "$candidate" "$crf" "$include_audio" "$vf"
    candidate_size="$(get_file_size "$candidate")"
    candidate_ssim="$(measure_ssim "$reference_path" "$candidate")"

    echo "try  crf=${crf} size=$(format_mb "$candidate_size")MB ssim=${candidate_ssim}" >&2

    if [[ -z "$best" ]] || awk -v s="$candidate_ssim" -v b="$best_ssim" 'BEGIN { exit !(s > b) }'; then
      best="$candidate"
      best_size="$candidate_size"
      best_ssim="$candidate_ssim"
      best_crf="$crf"
    fi

    if awk -v s="$candidate_ssim" -v q="$QUALITY_SSIM" 'BEGIN { exit !(s >= q) }'; then
      selected="$candidate"
      selected_size="$candidate_size"
      selected_ssim="$candidate_ssim"
      selected_crf="$crf"
      break
    fi
  done

  if [[ -z "$selected" ]]; then
    selected="$best"
    selected_size="$best_size"
    selected_ssim="$best_ssim"
    selected_crf="$best_crf"
    echo "warn no candidate reached QUALITY_SSIM=${QUALITY_SSIM}; using best sampled SSIM" >&2
  fi

  if [[ "$NEVER_GROW" == "1" && "$selected_size" -ge "$reference_size" ]]; then
    cp -f "$reference_path" "$output_path"
    echo "Keep $reference_path -> $output_path ($(format_mb "$reference_size")MB; dynamic encode would not shrink)"
  else
    cp -f "$selected" "$output_path"
    echo "OK   $reference_path -> $output_path ($(format_mb "$reference_size")MB -> $(format_mb "$selected_size")MB, crf=${selected_crf}, ssim=${selected_ssim}, vf='${vf:-none}', audio=$([[ "$include_audio" == "1" ]] && echo keep || echo strip))"
  fi
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/compress_mp4_pipeline.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

reference_video="$tmp_dir/reference.mp4"
build_reference "$input_video" "$reference_video"
compress_dynamic_from_reference "$reference_video" "$output_video"
