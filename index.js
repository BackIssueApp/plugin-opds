// OPDS catalog plugin for BackIssue — serves the library to OPDS reader apps
// (Panels, Chunky, KyBook, …): search and browse series, download CBZ/CBR/PDF
// files, and stream page-by-page via OPDS-PSE when the reader plugin is
// installed (its page pipeline does the extraction/resizing — nothing is
// duplicated). The root offers shelves: all series, recently added, by
// publisher, and — when the reader plugin is present — continue reading and a
// read-later shelf.
//
// Point an app at:  http(s)://<host>/api/opds   with your BackIssue username
// and password (HTTP Basic — the core verifies it against the users table).
// Access rides the plugin-registered `opds.use` permission (viewer tier).
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import {
  rootFeed, opensearchDoc, seriesNavFeed, publishersNavFeed, seriesAcqFeed, issuesAcqFeed,
  recentIssues, issuesByIds, readerContinue, readerLater, hasReaderTables,
  visibleLists, listMeta, listIssues, listsNavFeed, listAcqFeed,
  bestFile, fileType, downloadName, seriesRestricted, issueRestricted, PAGE_SIZE, NAV, ACQ,
} from './feeds.js';
import {
  rootDoc, seriesDoc, publishersDoc, issuesDoc, seriesIssuesDoc, OPDS2,
  booksRootDoc, allBooksDoc, recentBooksDoc, bookAuthorsDoc, booksByAuthorDoc,
  bookSeriesDoc, booksBySeriesDoc, bookLibrariesDoc, booksByLibraryDoc, booksSearchDoc,
} from './feeds2.js';
import {
  hasEbookTables, hasBooks, booksRootNavFeed, allBooksFeed, recentBooksFeed,
  bookAuthorsNavFeed, booksByAuthorFeed, bookSeriesNavFeed, booksBySeriesFeed,
  bookLibrariesNavFeed, booksByLibraryFeed, booksSearchFeed, booksOpensearchDoc,
} from './feeds-books.js';
import { roleGrants, CORE_PERMISSIONS } from '../../src/users.js';
import { registeredPermissions } from '../../src/plugins.js';

const OSD_TYPE = 'application/opensearchdescription+xml';

export default async function register(api) {
  const CAN = api.registerPermission ? 'opds.use' : 'viewer';
  api.registerPermission?.({
    key: 'opds.use',
    label: 'OPDS catalog',
    description: 'Search, browse, download, and stream the library from OPDS reader apps',
    tier: 'viewer',
  });

  // Show the user their OPDS catalog URL on the Profile page (only if the host
  // supports client assets — older cores just skip it).
  api.registerClientAsset?.({ js: 'client/ui.js', css: 'client/opds.css' });

  // Read-only catalog view — this handle never writes. (The DB is already WAL
  // from core; a readonly handle can't set journal_mode, and doesn't need to.)
  // The one thing the plugin records — streamed-page reading progress — goes
  // through the reader plugin's own store below, never this connection.
  const db = new Database(config.dbPath, { readonly: true });
  try { db.pragma('busy_timeout = 5000'); } catch { /* readonly: best effort */ }

  // "Recently added" walks the newest files through a small partial index —
  // the same one the reader's New in library shelf uses (whichever plugin
  // loads first creates it). A one-off writable handle, closed straight away;
  // without it the feed still works, just with a sort over every file.
  try {
    const w = new Database(config.dbPath);
    try {
      w.exec('CREATE INDEX IF NOT EXISTS idx_libfiles_newest ON library_files(mtime) WHERE valid = 1 AND cv_issue_id IS NOT NULL');
      // "By author" looks books up by the publisher slot. Core creates this
      // same index from the next release on; created here for older cores.
      w.exec('CREATE INDEX IF NOT EXISTS idx_series_publisher ON series(publisher)');
    }
    finally { w.close(); }
  } catch { /* busy or an older core — the feed falls back to a sort */ }

  // The reader plugin's page pipeline (archive → page image, resize, cache).
  // Optional: without it the catalog still serves whole-file downloads.
  let pages = null;
  try { pages = await import('../reader/pages.js'); } catch { /* downloads only */ }
  const streaming = !!pages;

  // The reader plugin's progress store — the ONE writer of reading state. Page
  // streaming infers progress from the pages an app fetches and records it
  // through the reader's own semantics (forward-only, first-completion latch),
  // so OPDS reading feeds "Continue reading", the apps, and reading stats
  // exactly like the built-in reader. The catalog handle above stays readonly.
  let readerStore = null;
  try { readerStore = (await import('../reader/store.js')).openReaderStore(config.dbPath); } catch { /* no reader → no PSE either */ }

  // Off by default only via Settings; a client can also opt out per-request
  // with ?progress=0 on the stream URL.
  api.registerSettings?.({ opdsSaveProgress: { type: 'bool' } });
  const savingProgress = () => config.opdsSaveProgress !== false;

  // Streamed-page progress inference. Deliberately FORWARD-ONLY: a fetch can
  // advance the resume point but never move it back, which also defuses
  // out-of-order prefetching. Completion uses the reader's latch (fires once,
  // ever) when the final page is fetched.
  function recordStreamedPage(userId, cvIssueId, n, pageCount) {
    if (!readerStore || !savingProgress()) return;
    try {
      const cur = readerStore.progress(userId, cvIssueId);
      const total = pageCount || cur.pages || 0;
      const last = total > 0 && n >= total - 1;
      if (n > (cur.page | 0) || (last && !cur.completed)) {
        readerStore.saveProgress(userId, cvIssueId, { page: n, pages: total, completed: last });
      }
    } catch { /* progress is best-effort; never fail the page */ }
  }

  const xml = (res, kind, body) => {
    res.set('Content-Type', kind);
    res.set('Cache-Control', 'private, max-age=60');
    res.send(body);
  };
  // OPDS 2.0 JSON (application/opds+json), not res.json() which forces
  // application/json — some 2.0 clients check the type.
  const json = (res, obj) => {
    res.set('Content-Type', OPDS2);
    res.set('Cache-Control', 'private, max-age=60');
    res.send(JSON.stringify(obj));
  };
  const OPTS = { access: CAN, basicAuth: true };

  // Mature/restricted enforcement — a role without library.restricted sees no
  // restricted series in the catalog, and can't download/stream their issues;
  // nor does an account that switched mature content off for itself.
  const permCatalog = new Map([...CORE_PERMISSIONS, ...registeredPermissions()].map((p) => [p.key, p]));
  const canRestricted = (req) => {
    if (!req.user || req.user.id === 0) return true;
    try { return roleGrants(db, req.user.role, 'library.restricted', permCatalog) && !req.user.hide_mature; } catch { return false; }
  };
  // Books ride the ebooks plugin's own permission — the acquisition link points
  // at /api/ebooks/issue/:id/file (an ebooks.use route), so a reader who can't
  // download a book must not be shown one. Absent the ebooks plugin, ebooks.use
  // isn't in the catalog and this denies (there are no books to show anyway).
  const canEbooks = (req) => {
    if (!req.user || req.user.id === 0) return true;
    try { return roleGrants(db, req.user.role, 'ebooks.use', permCatalog); } catch { return false; }
  };
  // Show the Books branch only when this reader may use it AND at least one
  // book is visible to them.
  const booksVisible = (req) => canEbooks(req) && hasBooks(db, { includeRestricted: canRestricted(req) });
  // Clamp a ?page param to a sane positive integer.
  const pageOf = (req) => Math.max(1, Number(req.query.page) || 1);
  const uid = (req) => (req.user && req.user.id) || 0;

  // Root menu (shelves) + the OpenSearch description document clients fetch to
  // wire up their search box.
  api.registerRoute('get', '/api/opds', (req, res) => {
    xml(res, NAV, rootFeed({ hasReader: hasReaderTables(db), hasBooks: booksVisible(req), hasLists: visibleLists(db, uid(req)).length > 0 }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/opensearch.xml', (req, res) => {
    xml(res, OSD_TYPE, opensearchDoc());
  }, OPTS);

  // Search (OpenSearch target) — a paginated series list filtered by ?q.
  api.registerRoute('get', '/api/opds/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    xml(res, NAV, seriesNavFeed(db, { includeRestricted: canRestricted(req), search: q, page: pageOf(req) }));
  }, OPTS);

  // All series (paginated, with publisher facets).
  api.registerRoute('get', '/api/opds/series', (req, res) => {
    xml(res, NAV, seriesNavFeed(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);

  // Browse by publisher.
  api.registerRoute('get', '/api/opds/publishers', (req, res) => {
    xml(res, NAV, publishersNavFeed(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/publisher/:name', (req, res) => {
    xml(res, NAV, seriesNavFeed(db, { includeRestricted: canRestricted(req), publisher: String(req.params.name), page: pageOf(req) }));
  }, OPTS);

  // Recently added issues (acquisition feed).
  api.registerRoute('get', '/api/opds/recent', (req, res) => {
    const rows = recentIssues(db, { includeRestricted: canRestricted(req), limit: PAGE_SIZE });
    xml(res, ACQ, issuesAcqFeed(rows, { id: 'opds:recent', title: 'Recently added', self: '/api/opds/recent', streaming, db, userId: uid(req) }));
  }, OPTS);

  // Reading shelves (per-user; empty/hidden when the reader plugin is absent).
  api.registerRoute('get', '/api/opds/continue', (req, res) => {
    const ids = readerContinue(db, uid(req), { limit: PAGE_SIZE });
    const rows = issuesByIds(db, ids, { includeRestricted: canRestricted(req) });
    xml(res, ACQ, issuesAcqFeed(rows, { id: 'opds:continue', title: 'Continue reading', self: '/api/opds/continue', streaming, db, userId: uid(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/later', (req, res) => {
    const ids = readerLater(db, uid(req));
    const rows = issuesByIds(db, ids, { includeRestricted: canRestricted(req) });
    xml(res, ACQ, issuesAcqFeed(rows, { id: 'opds:later', title: 'Read later', self: '/api/opds/later', streaming, db, userId: uid(req) }));
  }, OPTS);

  // Reading lists + imported story arcs, in reading order — the OPDS answer to
  // "what should I read next". Own lists first, then any shared with everyone.
  api.registerRoute('get', '/api/opds/lists', (req, res) => {
    xml(res, NAV, listsNavFeed(visibleLists(db, uid(req))));
  }, OPTS);
  api.registerRoute('get', '/api/opds/list/:id', (req, res) => {
    const meta = listMeta(db, uid(req), Number(req.params.id));
    if (!meta) return res.status(404).end();
    const rows = listIssues(db, Number(req.params.id), { includeRestricted: canRestricted(req) });
    xml(res, ACQ, listAcqFeed(rows, meta, { streaming, db, userId: uid(req) }));
  }, OPTS);

  api.registerRoute('get', '/api/opds/series/:id', (req, res) => {
    if (!canRestricted(req) && seriesRestricted(db, Number(req.params.id))) return res.status(404).end();
    const feed = seriesAcqFeed(db, Number(req.params.id), { streaming, userId: uid(req) });
    if (!feed) return res.status(404).end();
    xml(res, ACQ, feed);
  }, OPTS);

  // ---- Ebooks (EPUB/PDF) branch — OPDS 1.2. --------------------------------
  // Downloads + covers go through the ebooks plugin's own routes (which the
  // reader reaches with the same HTTP Basic credentials — see auth note in the
  // README). Every book route is gated on ebooks.use; without it the branch is
  // invisible (404), so a reader is never shown a book it can't download.
  const bookGate = (req, res) => {
    if (!canEbooks(req)) { res.status(404).end(); return false; }
    return true;
  };
  api.registerRoute('get', '/api/opds/books', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, NAV, booksRootNavFeed(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/opensearch.xml', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, OSD_TYPE, booksOpensearchDoc());
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/search', (req, res) => {
    if (!bookGate(req, res)) return;
    const q = String(req.query.q || '').trim();
    xml(res, ACQ, booksSearchFeed(db, { search: q, includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/all', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, ACQ, allBooksFeed(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/recent', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, ACQ, recentBooksFeed(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/authors', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, NAV, bookAuthorsNavFeed(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/author/:name', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, ACQ, booksByAuthorFeed(db, String(req.params.name), { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/series', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, NAV, bookSeriesNavFeed(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/series/:id', (req, res) => {
    if (!bookGate(req, res)) return;
    const feed = booksBySeriesFeed(db, Number(req.params.id), { includeRestricted: canRestricted(req) });
    if (!feed) return res.status(404).end();
    xml(res, ACQ, feed);
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/libraries', (req, res) => {
    if (!bookGate(req, res)) return;
    xml(res, NAV, bookLibrariesNavFeed(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/books/library/:id', (req, res) => {
    if (!bookGate(req, res)) return;
    const feed = booksByLibraryFeed(db, Number(req.params.id), { includeRestricted: canRestricted(req), page: pageOf(req) });
    if (!feed) return res.status(404).end();
    xml(res, ACQ, feed);
  }, OPTS);

  // ---- OPDS 2.0 (JSON) — same catalog, JSON shape, mounted under /v2. -------
  // Whole-file downloads and PSE page images reuse the 1.2 routes below.
  api.registerRoute('get', '/api/opds/v2', (req, res) => {
    json(res, rootDoc({ hasReader: hasReaderTables(db), hasBooks: booksVisible(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/search', (req, res) => {
    const q = String(req.query.query || req.query.q || '').trim();
    json(res, seriesDoc(db, { includeRestricted: canRestricted(req), search: q, page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/series', (req, res) => {
    json(res, seriesDoc(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/publishers', (req, res) => {
    json(res, publishersDoc(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/publisher/:name', (req, res) => {
    json(res, seriesDoc(db, { includeRestricted: canRestricted(req), publisher: String(req.params.name), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/recent', (req, res) => {
    const rows = recentIssues(db, { includeRestricted: canRestricted(req), limit: PAGE_SIZE });
    json(res, issuesDoc(rows, { title: 'Recently added', self: '/api/opds/v2/recent', streaming }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/continue', (req, res) => {
    const rows = issuesByIds(db, readerContinue(db, uid(req), { limit: PAGE_SIZE }), { includeRestricted: canRestricted(req) });
    json(res, issuesDoc(rows, { title: 'Continue reading', self: '/api/opds/v2/continue', streaming }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/later', (req, res) => {
    const rows = issuesByIds(db, readerLater(db, uid(req)), { includeRestricted: canRestricted(req) });
    json(res, issuesDoc(rows, { title: 'Read later', self: '/api/opds/v2/later', streaming }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/series/:id', (req, res) => {
    if (!canRestricted(req) && seriesRestricted(db, Number(req.params.id))) return res.status(404).end();
    const doc = seriesIssuesDoc(db, Number(req.params.id), { streaming });
    if (!doc) return res.status(404).end();
    json(res, doc);
  }, OPTS);

  // ---- Ebooks branch — OPDS 2.0 (JSON). Same queries, JSON shape. ----------
  api.registerRoute('get', '/api/opds/v2/books', (req, res) => {
    if (!bookGate(req, res)) return;
    json(res, booksRootDoc(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/search', (req, res) => {
    if (!bookGate(req, res)) return;
    const q = String(req.query.query || req.query.q || '').trim();
    json(res, booksSearchDoc(db, { search: q, includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/all', (req, res) => {
    if (!bookGate(req, res)) return;
    json(res, allBooksDoc(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/recent', (req, res) => {
    if (!bookGate(req, res)) return;
    json(res, recentBooksDoc(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/authors', (req, res) => {
    if (!bookGate(req, res)) return;
    json(res, bookAuthorsDoc(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/author/:name', (req, res) => {
    if (!bookGate(req, res)) return;
    json(res, booksByAuthorDoc(db, String(req.params.name), { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/series', (req, res) => {
    if (!bookGate(req, res)) return;
    json(res, bookSeriesDoc(db, { includeRestricted: canRestricted(req), page: pageOf(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/series/:id', (req, res) => {
    if (!bookGate(req, res)) return;
    const doc = booksBySeriesDoc(db, Number(req.params.id), { includeRestricted: canRestricted(req) });
    if (!doc) return res.status(404).end();
    json(res, doc);
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/libraries', (req, res) => {
    if (!bookGate(req, res)) return;
    json(res, bookLibrariesDoc(db, { includeRestricted: canRestricted(req) }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/v2/books/library/:id', (req, res) => {
    if (!bookGate(req, res)) return;
    const doc = booksByLibraryDoc(db, Number(req.params.id), { includeRestricted: canRestricted(req), page: pageOf(req) });
    if (!doc) return res.status(404).end();
    json(res, doc);
  }, OPTS);

  // Whole-file download (the standard OPDS acquisition link). res.sendFile
  // handles Range/If-Modified-Since, so large archives are resumable.
  api.registerRoute('get', '/api/opds/issue/:id/file', (req, res) => {
    if (!canRestricted(req) && issueRestricted(db, Number(req.params.id))) return res.status(404).end();
    const f = bestFile(db, Number(req.params.id));
    if (!f) return res.status(404).end();
    // No exists check first: sendFile stats the file anyway and reports a
    // missing one to the callback below (a 404), without a blocking stat.
    const name = downloadName(db, Number(req.params.id), f.path);
    res.sendFile(f.path, {
      headers: {
        'Content-Type': fileType(f.path),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }, OPTS);

  // OPDS-PSE page stream: /page/:n?width=N (0-based, client substitutes
  // {pageNumber}/{maxWidth}). Also serves the cover/thumbnail links.
  api.registerRoute('get', '/api/opds/issue/:id/page/:n', async (req, res) => {
    if (!pages) return res.status(404).end();
    if (!canRestricted(req) && issueRestricted(db, Number(req.params.id))) return res.status(404).end();
    try {
      const f = bestFile(db, Number(req.params.id));
      if (!f) return res.status(404).end();
      const n = Number(req.params.n) | 0;
      const w = Number(req.query.width || req.query.w) | 0;
      // A page request is a reading signal (served fresh OR revalidated from
      // the app's cache) — infer progress unless the client opted out.
      const track = String(req.query.progress ?? '') !== '0';
      const etag = `"o${req.params.id}-${n}-${w}-${f.mtime || 0}"`;
      if (req.headers['if-none-match'] === etag) {
        if (track) recordStreamedPage(uid(req), Number(req.params.id), n, f.page_count | 0);
        return res.status(304).end();
      }
      const { buffer, contentType } = await pages.pageBufferResized(f.path, n, w, { webp: false });
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('ETag', etag);
      res.send(buffer);
      if (track) recordStreamedPage(uid(req), Number(req.params.id), n, f.page_count | 0);
    } catch (e) {
      // The page pipeline reports a vanished file as 'file missing on disk'.
      const missing = /file missing on disk/.test(String(e?.message || ''));
      res.status(missing || e?.code === 'ENOPAGE' ? 404 : 500).json({ error: String(e?.message || e) });
    }
  }, OPTS);
}
