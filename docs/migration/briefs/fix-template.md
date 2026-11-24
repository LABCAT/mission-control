# Fix a blocked PR (orchestrator brief)

You own PR #<PR> (branch `<BRANCH>`) in LABCAT/mission-control until it is unblocked.

1. `git fetch origin <BRANCH> main sprint/status && git checkout <BRANCH> && git merge origin/main` (never force-push; resolve conflicts keeping both sides).
2. Read the LATEST blocking review comment on PR #<PR> ("## Opus review (Kinsho stand-in)" or "## Kinsho review") and fix EVERY blocker it lists, each with a test that fails on the old code. Take cheap nits too. Read AGENTS.md (Migration last) and the "Decision" lines in `git show origin/sprint/status:docs/migration/STATUS.md`.
3. Schema: if the PR is labelled `needs-migration`, do not add a migration. If it is labelled `migration` and you change the schema, regenerate its migration so it stays on its own commit and re-run up/down/up + `.github/scripts/migration-round-trip.sh`. Never touch Neon.
4. Run `pnpm typecheck && pnpm lint && TEST_DATABASE_URL=<local test db> pnpm test && pnpm --filter cms build`; push (no force-push). If the PR is a draft, mark it ready.
5. Comment on PR #<PR>: each blocker and how you fixed it, and the new head SHA.
Never wait on approval prompts; relative paths only. No secrets or personal data in code, docs or logs. End with 2 lines: PR URL and head SHA.
