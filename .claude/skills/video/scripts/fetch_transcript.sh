#!/usr/bin/env bash
# Fetch a video's transcript. Prints the output path on success.
#
# Usage: fetch_transcript.sh <url> [outdir]
#
# Exit codes (the skill branches on these — keep them stable):
#   0  transcript written
#   2  bad usage
#   3  host unreachable / blocked by an egress policy  -> switch to the paste route
#   4  video has no captions available                 -> audio route or paste route
#   5  yt-dlp not installed                            -> pip3 install yt-dlp
set -uo pipefail

URL="${1:-}"
OUTDIR="${2:-./video-transcripts}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -n "$URL" ] || { echo "usage: fetch_transcript.sh <url> [outdir]" >&2; exit 2; }

HOST="$(printf '%s' "$URL" | sed -E 's#^[a-z]+://##i; s#/.*$##; s#^[^@]*@##; s#:.*$##')"

# --- rung 0: is the host even reachable from this session? -------------------
# A remote Claude Code (web) container enforces an egress allowlist; youtube.com
# is denied there. Fail fast and loudly rather than burning retries.
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${HOST}" 2>/dev/null)"
CURL_RC=$?
if [ "$CURL_RC" -ne 0 ] || [ "$CODE" = "000" ]; then
  echo "BLOCKED: cannot reach ${HOST} from this session (curl rc=${CURL_RC}, http=${CODE})." >&2
  echo "This is an egress policy denial, not a bug. Do NOT use mirror/scraper sites." >&2
  echo "Use the paste route: YouTube -> ...more -> Show transcript -> timestamps ON -> copy." >&2
  exit 3
fi

command -v yt-dlp >/dev/null 2>&1 || { echo "yt-dlp not installed. Run: pip3 install yt-dlp" >&2; exit 5; }

mkdir -p "$OUTDIR" || exit 2
STEM="$OUTDIR/video"

# --- rung 1: subtitles (human-written first, auto-generated as fallback) ------
yt-dlp --skip-download --write-subs --write-auto-subs \
       --sub-langs "en.*,en" --sub-format vtt \
       --print-to-file "%(title)s|%(channel)s|%(duration_string)s|%(upload_date)s|%(webpage_url)s" "$STEM.meta" \
       -o "$STEM.%(ext)s" "$URL" >/dev/null 2>"$STEM.err"
RC=$?

VTT="$(find "$OUTDIR" -maxdepth 1 -name 'video*.vtt' 2>/dev/null | sort | head -1)"

if [ -z "$VTT" ]; then
  if [ "$RC" -ne 0 ] && grep -qiE 'proxy|403|forbidden|tunnel' "$STEM.err" 2>/dev/null; then
    echo "BLOCKED: yt-dlp could not reach ${HOST} (see $STEM.err)." >&2
    exit 3
  fi
  echo "NO CAPTIONS: ${URL} exposes no en subtitles (see $STEM.err)." >&2
  echo "Next: audio route (ffmpeg + local whisper), or the paste route." >&2
  exit 4
fi

python3 "$HERE/vtt_to_text.py" "$VTT" "$STEM.txt" || exit 2

echo "--- source ---"
[ -f "$STEM.meta" ] && cat "$STEM.meta"
echo "--- transcript ---"
echo "$STEM.txt"
