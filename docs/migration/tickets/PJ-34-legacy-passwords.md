# PJ-34 – WordPress password hash verifier (scoped)

Repo: LABCAT/mission-control. Branch: `pj-34-legacy-passwords` from `main`. One PR.

Goal: imported WordPress users keep their passwords and are rehashed on first login.
This ticket builds only the verifier and the login-hook helper; wiring into Users happens in PJ-29/PJ-62.

Do
- New files only: `packages/payload-jobs/src/legacy-password.ts` + `legacy-password.test.ts`.
  Do NOT edit `packages/payload-jobs/src/index.ts`, `tenancy.ts`, `access.ts` or `apps/cms` (other open PRs own them). Export via a package.json `exports` subpath (`./legacy-password`) only if needed.
- `verifyLegacyWordPressHash(password, hash): Promise<boolean>` supporting:
  - phpass portable `$P$` / `$H$` (WordPress < 6.8), needs MD5 (Web Crypto has none): use `node:crypto` md5 (Workers has `nodejs_compat`; check `apps/cms/wrangler.*`).
  - WordPress 6.8+ `$wp$2y$...` (bcrypt over base64 HMAC-SHA384 of the password, key `wp-sha384`) – confirm the algorithm from WordPress core `wp_check_password` source, cite the version in a comment.
  - plain bcrypt `$2y$`/`$2a$`/`$2b$`.
  - Unknown formats return false (never throw on bad input).
- `legacyLoginHook` helper design: given user doc with `legacyPasswordHash`, on success return the new password to set and clear the legacy field; failures count toward Payload lockout. Pure function + tests, no collection changes.
- Pin any new dep exactly (verify version with `npm view`). Prefer zero deps; `bcryptjs` is acceptable.
- Tests: known vectors for each format (generate with PHP-free known values from WordPress test suite or published vectors; cite source), wrong password, malformed hash, timing-safe comparison.

Done: `pnpm -r typecheck lint test` pass. PR body: what changed, how verified, "Part of PJ-34".
