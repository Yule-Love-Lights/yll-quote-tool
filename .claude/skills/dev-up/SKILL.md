---
name: dev-up
description: Start (or revive) the dev environment on this machine without chasing ghosts: node_modules check, env unset, launch.json server start, health probe. Trigger: starting dev work, "start the dev server", a dev server that died mid-session.
---

# Dev Up

OneDrive and the Claude Code shell create fake bugs on this machine. Run this sequence
before debugging anything that looks environmental.

1. `node_modules` present? If missing, or the server just died unexpectedly: `npm ci`,
   then restart, before debugging anything else. Reason: OneDrive sync reaps processes
   and eats `node_modules`; multiple sessions lost time debugging "bugs" that were
   this.
2. Unset `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` in the shell before
   `npm run dev`. Reason: the Claude Code shell sets the key to an empty string, which
   overrides `.env.local` and 503s every AI route with "ANTHROPIC_API_KEY missing".
3. Start via `.claude/launch.json` and the preview tools (preview_start), not an
   ad-hoc shell command. Reason: the preview harness tracks the process and port;
   ad-hoc servers get orphaned and reaped.
4. Health probe before trusting it:
   `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` and expect 200.
   Reason: a compiling-but-crashed server wastes a browser round trip.
5. A mid-session `.next` route-types tsc error is the dev server's codegen race, not
   your bug. Restart the server, re-run tsc. Reason: it was chased as a real failure
   once (S19); it never is.
6. Use the Bash tool for npm and npx, not PowerShell. Reason: PowerShell execution
   policy blocks `npx.ps1` and hangs.
