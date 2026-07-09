---
name: psql-ddl-migrations
description: "Jason's machine can apply prod DDL migrations via local psql + SUPABASE_DB_URL — no browser SQL editor needed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8fdfdd9f-7264-4868-adac-f3256849c272
---

# DDL migrations via psql (Jason's machine)

Jason's machine has **psql 17** (`C:\Program Files\PostgreSQL\17\bin\psql.exe`) and `.env.local` carries **`SUPABASE_DB_URL`** (the direct Postgres pooler connection string). So prod DDL migrations apply directly:

```powershell
$url = (Get-Content .env.local | Select-String '^SUPABASE_DB_URL=(.+)$').Matches[0].Groups[1].Value
& psql $url -v ON_ERROR_STOP=1 -f migrations/<file>.sql
```

First used S25 (2026-07-08) for `2026-07-08-permanent-training-examples.sql` — clean apply + schema verification queries in seconds.

**Why the old "browser SQL editor" rule existed:** the Supabase MCP is read-only for DDL (that part still holds — see [[task-ledger]] S13 note), and Naldo's machine went through the dashboard editor. The browser route is still the fallback; psql is strictly better when available (scriptable, ON_ERROR_STOP, instant verification). The dev's explicit go is still required before applying anything to prod — this changes the MECHANISM, not the approval gate. Never add `SUPABASE_DB_URL` to Vercel (existing deploy gotcha).
