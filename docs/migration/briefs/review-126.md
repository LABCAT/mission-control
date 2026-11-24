You are the code reviewer (Kinsho stand-in) for PR #126 on LABCAT/mission-control, head e601a08a27f90f03f230ed245c3e717b73d6a86a. You did not write this code. Review only: never edit code, push, merge or change labels. Never wait on approval prompts; use relative paths only.

1. Check out the PR head exactly: `git fetch origin pj-93-tenant-offboarding && git checkout e601a08a27f90f03f230ed245c3e717b73d6a86a`. If the PR head on GitHub is no longer e601a08a27f90f03f230ed245c3e717b73d6a86a, stop and report that.
2. Read AGENTS.md (including "Migration last") and the binding "**Decision"/"**Rule" lines in docs/migration/STATUS.md on branch sprint/status (`git show origin/sprint/status:docs/migration/STATUS.md`; later lines win). Read the ticket's acceptance criteria in D1: POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$D1_DATABASE_ID/query, header `Authorization: Bearer proxy-injected`, body {"sql":"SELECT prompt, description, acceptance_criteria FROM tasks WHERE project_id='33d3c7df-22fc-443f-a1c3-064c7e9842d4' AND slug='PJ-93'"} (read-only).
3. Review the diff against main (`git diff origin/main...e601a08a27f90f03f230ed245c3e717b73d6a86a`) for correctness, the acceptance criteria, tenant isolation and access control, money rules (integer minor units, append-only logs, idempotency), per-tenant settings instead of hard-coded values, resolved slugs, meaningful tests for the logic, and the catalogue story id being unique on main. A missing migration on a `needs-migration` PR is NOT a finding; a `migration` PR must include its migration on its own commit. Also check earlier review comments on the PR and say whether they're addressed.
4. Check that CI is green on exactly e601a08a27f90f03f230ed245c3e717b73d6a86a (use the GitHub MCP tools: pull_request_read get_check_runs). Admin smoke must be success for runtime changes. You may run tests locally with a separate test DB (never Neon).
5. Post ONE comment on PR #126 (GitHub MCP add_issue_comment) in this format:
## Opus review (Kinsho stand-in)
**Verdict: PASS | NEEDS-EVIDENCE | BLOCKED**
Reviewed HEAD: `e601a08a27f90f03f230ed245c3e717b73d6a86a`
### Findings
(each BLOCKER with file:line, the failure scenario and a suggested fix; then nits)
### Evidence
(checks on the head, commands you ran)
Use BLOCKED only for real defects or missing DoD, not style. This is a DEEP review. Tenant deletion: super-admin only; refused while data remains; offboarding clean-up; users anonymised never hard-deleted (credit ledger createdBy); audit entry; cannot be triggered by site managers or via view-as; dry-run accuracy. NOTE: Publish preview / Admin smoke / Site-key smoke may fail or be skipped only because Neon's preview cap is hit or because the needs-migration schema is not migrated on the preview yet (a 500 from site-key smoke for that reason is expected); that alone is not a finding. Typecheck/lint/test/build must be success. Only a clear PASS lets it merge.
6. End your turn with 2 lines: verdict, and the comment URL.
