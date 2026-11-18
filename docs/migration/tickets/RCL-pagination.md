# RCL – Pagination component (Rocketship)

Repo: LABCAT/rocketship. Branch: `rcl-pagination` from `main`. One PR.

Why: Mission Control's launchpad has a temporary local Pagination (marked for removal); it belongs in Rocketship.

Do
- `packages/base/src/components/Pagination.astro` following the existing components' conventions (BEM `rs-` classes, CSS variables per component, light/dark, tokens only). Read 2–3 existing components (e.g. Button, Table) first and mirror them.
- Props: `currentPage`, `totalPages`, `hrefFor` or `baseUrl` + query param name (default `page`), `siblingCount` (default 1), labels for i18n (`previous`, `next`, `page`, aria label). Plain links, zero client JS. `aria-current="page"`, ellipses, prev/next disabled states as non-links.
- Export it like other components; add a Storybook story and tests following the repo's existing test pattern.
- No Svelte port in this PR.
- Run every check in README "Before creating a pull request".

Done: all README checks pass. PR body: what changed, how verified, screenshots of the story in light and dark if the repo's tooling allows.
