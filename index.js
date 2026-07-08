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
import fs from 'node:fs';
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import {
  rootFeed, opensearchDoc, seriesNavFeed, publishersNavFeed, seriesAcqFeed, issuesAcqFeed,
  recentIssues, issuesByIds, readerContinue, readerLater, hasReaderTables,
  bestFile, fileType, downloadName, seriesRestricted, issueRestricted, PAGE_SIZE, NAV, ACQ,
} from './feeds.js';
import {
  rootDoc, seriesDoc, publishersDoc, issuesDoc, seriesIssuesDoc, OPDS2,
} from './feeds2.js';
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

  // Read-only catalog view — the plugin never writes. (The DB is already WAL
  // from core; a readonly handle can't set journal_mode, and doesn't need to.)
  const db = new Database(config.dbPath, { readonly: true });
  try { db.pragma('busy_timeout = 5000'); } catch { /* readonly: best effort */ }

  // The reader plugin's page pipeline (archive → page image, resize, cache).
  // Optional: without it the catalog still serves whole-file downloads.
  let pages = null;
  try { pages = await import('../reader/pages.js'); } catch { /* downloads only */ }
  const streaming = !!pages;

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
  // restricted series in the catalog, and can't download/stream their issues.
  const permCatalog = new Map([...CORE_PERMISSIONS, ...registeredPermissions()].map((p) => [p.key, p]));
  const canRestricted = (req) => {
    if (!req.user || req.user.id === 0) return true;
    try { return roleGrants(db, req.user.role, 'library.restricted', permCatalog); } catch { return false; }
  };
  // Clamp a ?page param to a sane positive integer.
  const pageOf = (req) => Math.max(1, Number(req.query.page) || 1);
  const uid = (req) => (req.user && req.user.id) || 0;

  // Root menu (shelves) + the OpenSearch description document clients fetch to
  // wire up their search box.
  api.registerRoute('get', '/api/opds', (req, res) => {
    xml(res, NAV, rootFeed({ hasReader: hasReaderTables(db) }));
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
    xml(res, ACQ, issuesAcqFeed(rows, { id: 'opds:recent', title: 'Recently added', self: '/api/opds/recent', streaming }));
  }, OPTS);

  // Reading shelves (per-user; empty/hidden when the reader plugin is absent).
  api.registerRoute('get', '/api/opds/continue', (req, res) => {
    const ids = readerContinue(db, uid(req), { limit: PAGE_SIZE });
    const rows = issuesByIds(db, ids, { includeRestricted: canRestricted(req) });
    xml(res, ACQ, issuesAcqFeed(rows, { id: 'opds:continue', title: 'Continue reading', self: '/api/opds/continue', streaming }));
  }, OPTS);
  api.registerRoute('get', '/api/opds/later', (req, res) => {
    const ids = readerLater(db, uid(req));
    const rows = issuesByIds(db, ids, { includeRestricted: canRestricted(req) });
    xml(res, ACQ, issuesAcqFeed(rows, { id: 'opds:later', title: 'Read later', self: '/api/opds/later', streaming }));
  }, OPTS);

  api.registerRoute('get', '/api/opds/series/:id', (req, res) => {
    if (!canRestricted(req) && seriesRestricted(db, Number(req.params.id))) return res.status(404).end();
    const feed = seriesAcqFeed(db, Number(req.params.id), { streaming });
    if (!feed) return res.status(404).end();
    xml(res, ACQ, feed);
  }, OPTS);

  // ---- OPDS 2.0 (JSON) — same catalog, JSON shape, mounted under /v2. -------
  // Whole-file downloads and PSE page images reuse the 1.2 routes below.
  api.registerRoute('get', '/api/opds/v2', (req, res) => {
    json(res, rootDoc({ hasReader: hasReaderTables(db) }));
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

  // Whole-file download (the standard OPDS acquisition link). res.sendFile
  // handles Range/If-Modified-Since, so large archives are resumable.
  api.registerRoute('get', '/api/opds/issue/:id/file', (req, res) => {
    if (!canRestricted(req) && issueRestricted(db, Number(req.params.id))) return res.status(404).end();
    const f = bestFile(db, Number(req.params.id));
    if (!f || !fs.existsSync(f.path)) return res.status(404).end();
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
      if (!f || !fs.existsSync(f.path)) return res.status(404).end();
      const n = Number(req.params.n) | 0;
      const w = Number(req.query.width || req.query.w) | 0;
      const etag = `"o${req.params.id}-${n}-${w}-${f.mtime || 0}"`;
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      const { buffer, contentType } = await pages.pageBufferResized(f.path, n, w, { webp: false });
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('ETag', etag);
      res.send(buffer);
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, OPTS);
}
