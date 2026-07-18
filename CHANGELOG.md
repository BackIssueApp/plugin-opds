# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [1.2.0] — 2026-07-18

### Added
- **Reading progress syncs over page streaming.** Stream links now carry
  `pse:lastRead` / `pse:lastReadDate`, so PSE apps resume where you left
  off — and streaming a page records progress through the reader plugin's own
  store (forward-only: your resume point advances, never regresses; fetching
  the last page marks the issue read, once). OPDS reading now feeds
  "Continue reading", the apps, and reading stats like the built-in reader.
  Toggle under Settings (on by default); clients can opt out per-request with
  `?progress=0`. Whole-file downloads are unchanged (no progress channel
  exists for them).

## [1.1.0] — 2026-07-08

### Added
- The OPDS catalog URL is shown on the user profile, ready to paste into a
  reader app.

## [1.0.1] — 2026-07-08

Initial release: serve the library over OPDS 1.2 + 2.0 for external comic
reader apps — browsing, search, downloads, and page streaming (PSE) so apps
can read without downloading whole files.
