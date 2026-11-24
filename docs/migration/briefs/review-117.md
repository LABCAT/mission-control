You are the code reviewer (Kinsho stand-in) for PR #117 on LABCAT/mission-control, head 465548bf5513b6c3331abf27f2646096ec355eca. You did not write this code. Review only: never edit code, push, merge or change labels. Never wait on approval prompts; use relative paths only.

1. Check out the PR head exactly: `git fetch origin openhands/pj-88-application-retention && git checkout 465548bf5513b6c3331abf27f2646096ec355eca`. If the PR head on GitHub is no longer 465548bf5513b6c3331abf27f2646096ec355eca, stop and report that.
2. Read AGENTS.md (including "Migration last") and the binding "**Decision"/"**Rule" lines in docs/migration/STATUS.md on branch sprint/status (`git show origin/sprint/status:docs/migration/STATUS.md`; later lines win). Read the ticket's acceptance criteria in D1: POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$D1_DATABASE_ID/query, header `Authorization: Bearer proxy-injected`, body {"sql":"SELECT prompt, description, acceptance_criteria FROM tasks WHERE project_id='33d3c7df-22fc-443f-a1c3-064c7e9842d4' AND slug='PJ-88'"} (read-only).
3. Review the diff against main (`git diff origin/main...465548bf5513b6c3331abf27f2646096ec355eca`) for correctness, the acceptance criteria, tenant isolation and access control, money rules (integer minor units, append-only logs, idempotency), per-tenant settings instead of hard-coded values, resolved slugs, meaningful tests for the logic, and the catalogue story id being unique on main. A missing migration on a `needs-migration` PR is NOT a finding; a `migration` PR must include its migration on its own commit. Also check earlier review comments on the PR and say whether they're addressed.
4. Check that CI is green on exactly 465548bf5513b6c3331abf27f2646096ec355eca (use the GitHub MCP tools: pull_request_read get_check_runs). Admin smoke must be success for runtime changes. You may run tests locally with a separate test DB (never Neon).
5. Post ONE comment on PR #117 (GitHub MCP add_issue_comment) in this format:
## Opus review (Kinsho stand-in)
**Verdict: PASS | NEEDS-EVIDENCE | BLOCKED**
Reviewed HEAD: `465548bf5513b6c3331abf27f2646096ec355eca`
### Findings
(each BLOCKER with file:line, the failure scenario and a suggested fix; then nits)
### Evidence
(checks on the head, commands you ran)
Use BLOCKED only for real defects or missing DoD, not style. This is a DEEP review. Deletes applications and CV files after retention: check tenant scoping, per-tenant retention value, R2 deletion correctness, batch-safety/idempotency, the admin delete-applicant action (who can call it), no personal data in logs. NOTE: Publish preview / Admin smoke / Site-key smoke may fail or be skipped only because Neon's preview cap is hit or because the needs-migration schema is not migrated on the preview yet (a 500 from site-key smoke for that reason is expected); that alone is not a finding. Typecheck/lint/test/build must be success. Only a clear PASS lets it merge.
6. End your turn with 2 lines: verdict, and the comment URL.
