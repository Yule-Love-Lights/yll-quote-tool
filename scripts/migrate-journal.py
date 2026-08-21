"""One-time (but re-runnable) conversion: split the four session logs into
per-session fragment files under docs/context/journal/.

Sources: session_log.md + session_log_archive.md (Jason),
session_log_naldo.md + session_log_naldo_archive.md (Naldo).

Rules:
- A session section starts at a line beginning with '### ' that contains an
  S-number, and runs until the next such line or end of file. POST-CLOSE DELTA
  blocks sit inside their session's span and travel with it.
- Fragment name: S<N>-<dev>.md. A second section with the same number and dev
  (sibling sessions are a real thing in this repo) gets -b, -c suffixes in
  encounter order (active file first, then archive, newest-on-top order kept).
- File preamble (frontmatter, header warnings) is NOT session content and stays
  in the original logs, which this script never modifies.
- Idempotent: deletes only fragments it generated before (S*-naldo*.md,
  S*-jason*.md) and rewrites them, so re-running at merge time picks up any
  lines that landed in the logs since the last run. S0-example.md untouched.
- Prints a coverage check: session-section line counts per source vs lines
  written, and any section it could not number.

Run from the repo root:  python scripts/migrate-journal.py
"""
import io, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CTX = os.path.join(ROOT, "docs", "context")
OUT = os.path.join(CTX, "journal")

SOURCES = [
    ("jason", os.path.join(CTX, "session_log.md")),
    ("jason", os.path.join(CTX, "session_log_archive.md")),
    ("naldo", os.path.join(CTX, "session_log_naldo.md")),
    ("naldo", os.path.join(CTX, "session_log_naldo_archive.md")),
]

# Matches every header generation: "### Naldo S62", "### S43 (Jason)",
# "### Session 29 (Jason)", and letter-suffixed siblings like "### Naldo S15b".
HEAD = re.compile(r"^### .*?\b(?:S|Session )(\d+)([a-z])?\b")

def split_sections(lines):
    """Yield (session_number_or_None, [lines]) for each ### section; the
    preamble before the first ### header is yielded with number None."""
    cur_num, cur = None, []
    started = False
    for ln in lines:
        m = HEAD.match(ln)
        if ln.startswith("### "):
            if started or cur:
                yield cur_num, cur
            cur = [ln]
            cur_num = (int(m.group(1)), m.group(2) or "") if m else -1
            started = True
        else:
            cur.append(ln)
    if cur:
        yield cur_num, cur

def main():
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, "S*-naldo*.md")) + glob.glob(
        os.path.join(OUT, "S*-jason*.md")
    ):
        os.remove(old)

    seen = {}
    stats, unnumbered = [], 0
    for dev, path in SOURCES:
        with io.open(path, encoding="utf-8-sig") as f:
            lines = f.read().splitlines(True)
        section_lines = written = 0
        for num, body in split_sections(lines):
            if num is None:
                continue  # preamble stays in the original log
            section_lines += len(body)
            if num == -1:
                unnumbered += 1
                sys.stderr.write(
                    "WARNING: un-numbered section in %s: %r\n" % (path, body[0][:80])
                )
                continue
            n, letter = num
            key = (n, letter, dev)
            seen[key] = seen.get(key, 0) + 1
            suffix = "" if seen[key] == 1 else "-" + "bcdefgh"[seen[key] - 2]
            name = "S%d%s-%s%s.md" % (n, letter, dev, suffix)
            with io.open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
                f.writelines(body)
            written += len(body)
        stats.append((os.path.basename(path), section_lines, written))

    print("source file: session-section lines -> lines written to fragments")
    ok = True
    for name, total, written in stats:
        flag = "OK" if total == written else "MISMATCH"
        if total != written:
            ok = False
        print("  %-34s %5d -> %5d  %s" % (name, total, written, flag))
    frags = sorted(os.listdir(OUT))
    print("fragments now in journal/: %d" % len([x for x in frags if x.startswith("S")]))
    if unnumbered:
        print("un-numbered sections skipped: %d (see stderr)" % unnumbered)
        ok = False
    print("coverage: %s" % ("COMPLETE" if ok else "INCOMPLETE, do not merge"))
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
