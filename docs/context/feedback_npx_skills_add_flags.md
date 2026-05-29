---
name: npx skills add — use -g -y to skip prompts
description: When installing skills via `npx skills add <repo>`, append `-g -y` to skip the interactive scope/confirmation prompts that hang non-TTY shells.
type: feedback
originSessionId: a4c1296f-cfe0-44dd-b7ab-24dfd65f523e
---
When running `npx skills add <repo> --skill <name>` from a tool-driven shell, always append `-g -y` (global + yes) so the install doesn't hang on the interactive "Installation scope" prompt.

**Why:** The CLI prompts for scope (Claude Code vs other agents) and confirmation by default. In a non-TTY shell (Bash/PowerShell tool calls), the prompt blocks indefinitely with no way to respond. Hit this twice on 2026-05-07: once with `supabase-postgres-best-practices` (outcome unknown), once with `audit-website` (had to re-run with flags).

**How to apply:** Default to `npx skills add <repo> --skill <name> -g -y` for all skill installs unless the user explicitly wants project-scoped installation. The CLI's own startup tip confirms this: "use the --yes (-y) and --global (-g) flags to install without prompts."

**Note on PowerShell:** `npx.ps1` is blocked by the system execution policy. Use the Bash tool instead.
