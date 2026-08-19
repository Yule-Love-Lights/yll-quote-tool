#!/usr/bin/env python3
"""Convert a WebVTT subtitle file into clean, timestamped, de-duplicated text.

YouTube's auto-captions use a rolling window: each cue repeats the tail of the
previous cue so the on-screen text scrolls. Concatenating them naively yields
2-3x the real word count. This collapses that back down and groups the result
into readable ~30s blocks prefixed with [mm:ss], so quotes stay citable.

Usage: vtt_to_text.py IN.vtt [OUT.txt] [--block-seconds N]
"""
import re
import sys
from collections import deque

TAG = re.compile(r"<[^>]+>")            # <c>, </c>, <00:00:01.199>
CUE = re.compile(
    r"^(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})"
)
DROP = ("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE", "REGION")


def to_seconds(stamp):
    h, m, s = stamp.replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def fmt(seconds):
    seconds = int(seconds)
    h, m, s = seconds // 3600, (seconds % 3600) // 60, seconds % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse(text):
    """Yield (start_seconds, line) for each distinct caption line, in order."""
    recent = deque(maxlen=8)          # rolling-window dedupe
    start = 0.0
    for raw in text.splitlines():
        line = raw.strip("﻿").rstrip()
        if not line or line.startswith(DROP):
            continue
        cue = CUE.match(line)
        if cue:
            start = to_seconds(cue.group(1))
            continue
        if line.isdigit():            # sequence number in SRT-style files
            continue
        clean = TAG.sub("", line).strip()
        clean = re.sub(r"\s+", " ", clean)
        if not clean or clean in recent:
            continue
        recent.append(clean)
        yield start, clean


def group(pairs, block_seconds):
    block_start, buf = None, []
    for start, line in pairs:
        if block_start is None:
            block_start = start
        if start - block_start >= block_seconds and buf:
            yield block_start, " ".join(buf)
            block_start, buf = start, [line]
        else:
            buf.append(line)
    if buf:
        yield block_start or 0.0, " ".join(buf)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    block = 30
    for a in sys.argv[1:]:
        if a.startswith("--block-seconds"):
            block = int(a.split("=", 1)[1]) if "=" in a else 30
    if not args:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    src = open(args[0], encoding="utf-8", errors="replace").read()
    out = [f"[{fmt(t)}] {body}" for t, body in group(parse(src), block)]
    body = "\n\n".join(out) + "\n"

    if len(args) > 1:
        # atomic-ish write: build the whole payload first, then place it
        tmp = args[1] + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(body)
        import os
        os.replace(tmp, args[1])
        words = len(body.split())
        print(f"wrote {args[1]} — {len(out)} blocks, ~{words} words", file=sys.stderr)
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
