# AGENTS.md

Instructions for AI coding agents. The full project context is in [CLAUDE.md](CLAUDE.md); read it first. The scope and ticket list are in `Canvas_Editor_Media_Platform_POC_Plan.md`.

Short version:
- Local-only POC on LocalStack and Docker Compose. No AWS accounts, no MediaConvert, no real AI.
- Work ticket by ticket (POC-001 to POC-040). Read the matching plan in `docs/plans/` if one exists.
- Postgres is the source of truth. Edits create revisions only and never trigger media jobs.
- Keep jobs idempotent. Never let GC delete a referenced asset.
- Do not claim the mock transcoder performs real transcoding.
- Pin image versions, bind ports to `127.0.0.1`, and never commit secrets.
