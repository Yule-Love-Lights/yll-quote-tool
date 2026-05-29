---
name: Claude Code empty ANTHROPIC_API_KEY overrides .env.local
description: When running Next.js dev server via Claude Code's Bash tool, the inherited shell sets ANTHROPIC_API_KEY="" which silently overrides .env.local — unset it before `npm run dev`
type: feedback
originSessionId: 9a796ca6-9b85-4647-b1fd-90436e9d1ffd
---
When starting a Next.js (or any Node) dev server through Claude Code's Bash tool, the inherited shell has `ANTHROPIC_API_KEY=""` (empty) and `ANTHROPIC_BASE_URL=https://api.anthropic.com` set. Shell env wins over `.env.local`, so `process.env.ANTHROPIC_API_KEY` is empty at runtime even though the file has a real key.

**Why:** Claude Code uses its own auth, so it exports an empty `ANTHROPIC_API_KEY` into its shell snapshot. Other env files' values load fine (Supabase, Gemini, Google Maps) because they aren't overridden by shell vars.

**How to apply:** Before starting a dev server from Bash in this environment, run:
```
unset ANTHROPIC_API_KEY; unset ANTHROPIC_BASE_URL; export PATH="/c/Program Files/nodejs:$PATH"; npm.cmd run dev
```
Symptoms that signal this is happening: API routes using Claude return 503 "ANTHROPIC_API_KEY missing" while Supabase/other APIs work fine. Confirm with `env | grep -i anthropic` — if you see `ANTHROPIC_API_KEY=` (empty), that's it.
