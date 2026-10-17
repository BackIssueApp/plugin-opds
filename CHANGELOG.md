# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Added

- **Translated UI.** The progress-sync card and the profile page's
  "Connect a reader app" block follow the language picked under Profile →
  Language on BackIssue builds newer than 0.9.0, and stay English on older
  ones. Translations ship for French, German, Spanish, Italian, Portuguese and
  Dutch in `locales/`. Feed titles are unchanged.
  Also covers the permission, job and library-type labels, the plugin
  description and the notification titles shown in BackIssue’s own screens.

## [1.4.0] — 2026-09-02

### Added
- **Reading lists in the catalog.** A **Reading lists** section now appears in
  the OPDS root, listing your own lists and story arcs plus any shared with
  you. Opening one serves its issues **in reading order**, so a reader app can
  answer "what do I read next" directly. Issues that aren't on the shelf yet
  still appear in their place (without a download link), so the order stays
  intact and gaps are visible. Read state rides along for apps that use it.

## [1.3.0] — 2026-07-25

### Added
- **Ebooks (EPUB/PDF) in the OPDS catalog.** When a Books library is present,
  the catalog root gains a "Books" branch so ebook reader apps (KOReader,
  Moon+ Reader, Thorium, Marvin, …) can browse and download it over OPDS —
  All books (A–Z), Recently added, By author, By series, and per-library when
  there is more than one book library. Each book is an acquisition entry with
  its author(s), language, ISBN, cover, and a download link typed to the book's
  format (`application/epub+zip` or `application/pdf`); on-demand books with no
  file yet are listed too and download on first open. Search covers books.
  Books are served over both the 1.2 (Atom) and 2.0 (JSON) catalogs, and are
  shown only to readers whose role includes the Books-library permission.

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
