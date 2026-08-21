# Journal fragments

This directory holds one file per session: `S<N>-<dev>.md`. `N` is the
session number, `dev` is `naldo` or `jason`.

## The rule

Each session writes only its own file. Once your session starts, only add
to `S<N>-<dev>.md` for your own `N`. Never open or edit another session's
fragment, even to fix a typo. Append to your own file as you go: do not
rewrite earlier parts of it.

This is the whole point of the fragment system. Two sessions can run at the
same time on two machines and never touch the same lines, because they are
never writing to the same file. The old single-file session logs could not
promise that: two sessions editing `session_log.md` at once meant merge
conflicts and, sometimes, a lost line.

## Shape of a fragment

See `S0-example.md` in this directory for the expected shape: session
number, dev, date, what shipped, findings. Keep entries short and plain.
No em dashes, short sentences, plain words.

## How a fragment gets created

`scripts/session-open.sh` claims a session number and creates a worktree
for it. It does not create the fragment file for you today; write
`S<N>-<dev>.md` yourself once you know what you shipped, following the
shape in `S0-example.md`.

## Building the combined view

`scripts/build-docs.sh` concatenates every `S<N>-<dev>.md` fragment, in
numeric order, into `docs/context/JOURNAL.md`. That file is generated. Do
not hand-edit it: edit your fragment and re-run the build script instead.

## Status

This is new tooling. It does not replace anything yet.
`docs/context/session_log.md` and `docs/context/session_log_naldo.md` stay
the live, authoritative session history until Naldo switches over. See
`MIGRATION.md` in this directory for that plan.
