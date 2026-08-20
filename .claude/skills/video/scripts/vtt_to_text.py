#!/usr/bin/env python3
"""Convert a WebVTT subtitle file into clean, timestamped, de-duplicated text.

YouTube's auto-captions use a rolling window: each cue repeats the tail of the
previous cue so the on-screen text scrolls. Concatenating them naively yields
2-3x the real word count. This collapses that back down and groups the result
into readable blocks prefixed with [mm:ss], so quotes stay citable.
"""
import argparse
import os
import re
import sys
from collections import deque

# The rolling duplication YouTube produces is adjacent-only: a line repeats at
# most ~2 positions back. Keep this window as small as that allows — every extra
# slot silently deletes real speech when a speaker repeats a short phrase
# ("Okay.", "Right.") within the window.
DEDUPE_WINDOW = 3

TAG = re.compile(r"<[^>]+>")            # <c>, </c>, <00:00:01.199>
STAMP = r"(?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3}"   # hours are optional in WebVTT
CUE = re.compile(rf"^({STAMP})\s*-->\s*({STAMP})")
HEADERS = ("WEBVTT", "Kind:", "Language:")
# These open a block that runs until the next blank line — not just one line.
BLOCKS = ("NOTE", "STYLE", "REGION")


def to_seconds(stamp):
    parts = stamp.replace(",", ".").split(":")
    if len(parts) == 3:
        h, m, s = parts
    else:
        h, m, s = 0, parts[0], parts[1]
    return int(h) * 3600 + int(m) * 60 + float(s)


def fmt(seconds):
    seconds = int(seconds)
    h, m, s = seconds // 3600, (seconds % 3600) // 60, seconds % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse(text):
    """Yield (start_seconds, line) for each distinct caption line, in order."""
    recent = deque(maxlen=DEDUPE_WINDOW)
    start = 0.0
    in_block = False
    for raw in text.splitlines():
        line = raw.strip("﻿").rstrip()
        if not line:
            in_block = False           # a blank line closes a NOTE/STYLE block
            continue
        if in_block:
            continue
        if line.startswith(BLOCKS):
            in_block = True
            continue
        if line.startswith(HEADERS):
            continue
        cue = CUE.match(line)
        if cue:
            start = to_seconds(cue.group(1))
            continue
        if line.isdigit():             # sequence number in SRT-style files
            continue
        clean = re.sub(r"\s+", " ", TAG.sub("", line)).strip()
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
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("src", help="input .vtt file")
    ap.add_argument("dest", nargs="?", help="output .txt (default: stdout)")
    ap.add_argument("--block-seconds", type=int, default=30,
                    help="seconds of speech per [mm:ss] block (default: 30)")
    args = ap.parse_args()

    with open(args.src, encoding="utf-8", errors="replace") as fh:
        src = fh.read()

    out = [f"[{fmt(t)}] {body}"
           for t, body in group(parse(src), args.block_seconds)]
    body = "\n\n".join(out) + "\n"

    if args.dest:
        # atomic: the payload is fully built above, so a fault cannot truncate
        tmp = args.dest + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.replace(tmp, args.dest)
        print(f"wrote {args.dest} — {len(out)} blocks, ~{len(body.split())} words",
              file=sys.stderr)
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
