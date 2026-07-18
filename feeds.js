// OPDS 1.2 feed builders — pure functions over the core catalog DB, kept
// apart from route wiring so they're testable without an HTTP server.
//
// Layout: root nav → shelves (all series / recently added / publishers /
// continue reading / read later) → per-series (or per-shelf) acquisition
// feeds whose entries carry a file download link and (when the reader
// plugin's page pipeline is available) an OPDS-PSE streaming link, so apps
// like Panels or Chunky can read page-by-page without downloading the
// archive. Series lists are searchable (OpenSearch), paginated, and carry
// publisher facets.
import path from 'node:path';

export const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

const FILE_TYPES = {
  '.cbz': 'application/vnd.comicbook+zip',
  '.cbr': 'application/vnd.comicbook-rar',
  '.pdf': 'application/pdf',
};
export const fileType = (p) => FILE_TYPES[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream';

export const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const OSD = 'application/opensearchdescription+xml';

export const PAGE_SIZE = 50;

const BASE = '/api/opds';
const OPENSEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Plain-text summary from a (possibly HTML) CV description, length-capped so a
// feed entry stays small.
export const stripHtml = (s, max = 500) => {
  const t = String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};

const head = (id, title, self, kind) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="http://vaemendis.net/opds-pse/ns" xmlns:opensearch="${OPENSEARCH}">
  <id>backissue:${esc(id)}</id>
  <title>${esc(title)}</title>
  <updated>${now()}</updated>
  <author><name>BackIssue</name></author>
  <link rel="self" href="${esc(self)}" type="${kind}"/>
  <link rel="start" href="${BASE}" type="${NAV}"/>
  <link rel="search" type="${OSD}" href="${BASE}/opensearch.xml"/>
`;

// Paging + OpenSearch result-count links for a feed. `self` is the feed URL
// without a page param (a query string is fine — the sep is chosen for it).
function pageLinks(self, kind, page, size, total) {
  const sep = self.includes('?') ? '&' : '?';
  const url = (p) => `${self}${sep}page=${p}`;
  const last = Math.max(1, Math.ceil(total / size));
  let out = `  <opensearch:totalResults>${total}</opensearch:totalResults>\n`
    + `  <opensearch:itemsPerPage>${size}</opensearch:itemsPerPage>\n`
    + `  <opensearch:startIndex>${(page - 1) * size + 1}</opensearch:startIndex>\n`
    + `  <link rel="first" href="${esc(url(1))}" type="${kind}"/>\n`;
  if (page > 1) out += `  <link rel="previous" href="${esc(url(page - 1))}" type="${kind}"/>\n`;
  if (page < last) out += `  <link rel="next" href="${esc(url(page + 1))}" type="${kind}"/>\n`;
  out += `  <link rel="last" href="${esc(url(last))}" type="${kind}"/>\n`;
  return out;
}

// ---- series queries ---------------------------------------------------------
// Shared WHERE for "series that have at least one readable (valid, CV-matched)
// file", plus optional restricted/search/publisher filters. Returns SQL text
// and bound params so the row + count queries stay in lock-step.
function seriesWhere({ includeRestricted = true, search = '', publisher = '' } = {}) {
  const conds = [];
  const params = [];
  if (!includeRestricted) conds.push('s.restricted = 0');
  if (search) { conds.push('COALESCE(cv.name, s.title) LIKE ?'); params.push('%' + search + '%'); }
  if (publisher) { conds.push('COALESCE(cv.publisher, s.publisher) = ?'); params.push(publisher); }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

// Series page (title prefers the ComicVine name; cover prefers CV art).
export function seriesRows(db, opts = {}) {
  const { where, params } = seriesWhere(opts);
  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? 0;
  return db.prepare(`
    SELECT s.id, COALESCE(cv.name, s.title) AS title, cv.start_year,
           COALESCE(cv.image_url, s.cover_url) AS cover,
           COUNT(DISTINCT lf.cv_issue_id) AS issues
      FROM series s
      JOIN library_files lf ON lf.series_id = s.id AND lf.valid = 1 AND lf.cv_issue_id IS NOT NULL
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     ${where}
     GROUP BY s.id ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, limit, offset);
}

export function seriesCount(db, opts = {}) {
  const { where, params } = seriesWhere(opts);
  const r = db.prepare(`
    SELECT COUNT(DISTINCT s.id) AS n
      FROM series s
      JOIN library_files lf ON lf.series_id = s.id AND lf.valid = 1 AND lf.cv_issue_id IS NOT NULL
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     ${where}`).get(...params);
  return r ? r.n : 0;
}

// Publishers with at least one readable series (for the browse shelf + facets).
export function publishers(db, { includeRestricted = true } = {}) {
  const pub = 'COALESCE(cv.publisher, s.publisher)';
  return db.prepare(`
    SELECT ${pub} AS publisher, COUNT(DISTINCT s.id) AS count
      FROM series s
      JOIN library_files lf ON lf.series_id = s.id AND lf.valid = 1 AND lf.cv_issue_id IS NOT NULL
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     WHERE ${pub} IS NOT NULL AND ${pub} <> ''
       ${includeRestricted ? '' : 'AND s.restricted = 0'}
     GROUP BY ${pub}
     ORDER BY ${pub} COLLATE NOCASE`).all();
}

// Is a series (by our id) restricted? And is an issue's series restricted?
export function seriesRestricted(db, seriesId) {
  try { const r = db.prepare('SELECT restricted FROM series WHERE id = ?').get(seriesId); return !!(r && r.restricted); }
  catch { return false; }
}
export function issueRestricted(db, cvIssueId) {
  try {
    return !!db.prepare(`SELECT 1 FROM cv_issues ci JOIN series s ON s.cv_id = ci.cv_series_id
      WHERE ci.comicvine_id = ? AND s.restricted = 1 LIMIT 1`).get(cvIssueId);
  } catch { return false; }
}

// ---- issue queries ----------------------------------------------------------
// One enriched row per readable CV issue (best file — tagged copy first, same
// rule as the reader). `extra`/`params` add a filter; `order`/`limit` shape the
// result. Carries everything an acquisition entry needs (size, cover, summary,
// series + publisher).
function issueRowsWhere(db, { extra = '', params = [], order = '', limit = null, includeRestricted = true } = {}) {
  const conds = ['lf.valid = 1', 'lf.cv_issue_id IS NOT NULL'];
  if (!includeRestricted) conds.push('s.restricted = 0');
  if (extra) conds.push(extra);
  const sql = `
    SELECT lf.cv_issue_id, lf.path, lf.size, lf.page_count, lf.mtime,
           ci.issue_number, ci.name AS title, ci.cover_date, ci.description, ci.image_url,
           s.id AS series_id, COALESCE(cs.name, s.title) AS series_title,
           COALESCE(cs.publisher, s.publisher) AS publisher
      FROM library_files lf
      JOIN series s ON s.id = lf.series_id
      LEFT JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
      LEFT JOIN cv_series cs ON cs.comicvine_id = s.cv_id
     WHERE ${conds.join(' AND ')}
       AND lf.path = (SELECT lf2.path FROM library_files lf2
                       WHERE lf2.cv_issue_id = lf.cv_issue_id AND lf2.valid = 1
                       ORDER BY lf2.has_metadata DESC, lf2.path LIMIT 1)
     GROUP BY lf.cv_issue_id
     ${order}${limit ? ' LIMIT ' + Number(limit) : ''}`;
  return db.prepare(sql).all(...params);
}

const num = (n) => { const f = parseFloat(String(n ?? '').replace(',', '.')); return Number.isFinite(f) ? f : null; };
const byIssueNumber = (a, b) => {
  const av = num(a.issue_number), bv = num(b.issue_number);
  if (av != null && bv != null) return av - bv;
  return String(a.issue_number).localeCompare(String(b.issue_number), undefined, { numeric: true });
};

// Readable issues of one series, natural issue order.
export function issueRows(db, seriesId, opts = {}) {
  const rows = issueRowsWhere(db, { extra: 'lf.series_id = ?', params: [seriesId], ...opts });
  return rows.sort(byIssueNumber);
}

// Most-recently-added readable issues, across the whole library.
export function recentIssues(db, { includeRestricted = true, limit = PAGE_SIZE } = {}) {
  return issueRowsWhere(db, { includeRestricted, order: 'ORDER BY lf.mtime DESC, lf.cv_issue_id DESC', limit });
}

// Enriched rows for a specific set of CV issue ids, returned in the given order.
export function issuesByIds(db, ids, { includeRestricted = true } = {}) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return [];
  const rows = issueRowsWhere(db, {
    includeRestricted,
    extra: `lf.cv_issue_id IN (${list.map(() => '?').join(',')})`,
    params: list,
  });
  const pos = new Map(list.map((id, i) => [id, i]));
  return rows.sort((a, b) => pos.get(a.cv_issue_id) - pos.get(b.cv_issue_id));
}

// ---- reader integration (soft dependency: tables exist iff reader plugin) ---
export function hasReaderTables(db) {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND name IN ('reader_progress','reader_later') LIMIT 1`).get();
  } catch { return false; }
}

/** CV issue ids the user has started but not finished, most recent first. */
export function readerContinue(db, userId, { limit = PAGE_SIZE } = {}) {
  try {
    return db.prepare(`
      SELECT p.issue_id FROM reader_progress p
       WHERE p.user_id = ? AND p.completed = 0 AND p.page > 0
         AND EXISTS (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = p.issue_id AND lf.valid = 1)
       ORDER BY p.updated_at DESC LIMIT ?`).all(userId, limit).map((r) => r.issue_id);
  } catch { return []; }
}

/** CV issue ids on the user's read-later shelf, most recently added first. */
export function readerLater(db, userId) {
  try {
    return db.prepare('SELECT issue_id FROM reader_later WHERE user_id = ? ORDER BY added_at DESC').all(userId).map((r) => r.issue_id);
  } catch { return []; }
}

/** Per-user reading progress for a set of issues (reader plugin's table, via
 *  this plugin's readonly handle): cvIssueId → { page, pages, completed,
 *  updated_at }. Empty map when the reader isn't installed. Feeds use it to
 *  stamp pse:lastRead on stream links so PSE apps resume where you left off. */
export function progressFor(db, userId, cvIssueIds) {
  const out = new Map();
  if (!cvIssueIds.length || !hasReaderTables(db)) return out;
  try {
    const q = db.prepare(`SELECT issue_id, page, pages, completed, updated_at FROM reader_progress
      WHERE user_id = ? AND issue_id IN (${cvIssueIds.map(() => '?').join(',')})`);
    for (const r of q.all(userId, ...cvIssueIds)) out.set(r.issue_id, r);
  } catch { /* reader mid-install */ }
  return out;
}

// ---- misc helpers -----------------------------------------------------------
export function bestFile(db, cvIssueId) {
  return db.prepare(`
    SELECT path, size, page_count, mtime FROM library_files
     WHERE cv_issue_id = ? AND valid = 1
     ORDER BY has_metadata DESC, path LIMIT 1`).get(cvIssueId) || null;
}

export function seriesTitle(db, seriesId) {
  const r = db.prepare(`
    SELECT COALESCE(cv.name, s.title) AS title FROM series s
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id WHERE s.id = ?`).get(seriesId);
  return r ? r.title : null;
}

// A human download filename ("Series - #012.cbz") from catalog metadata,
// falling back to the on-disk name. Illegal path chars are stripped.
export function downloadName(db, cvIssueId, filePath) {
  const ext = path.extname(String(filePath || '')) || '.cbz';
  const r = db.prepare(`
    SELECT COALESCE(cs.name, s.title) AS series, ci.issue_number
      FROM cv_issues ci
      JOIN series s ON s.cv_id = ci.cv_series_id
      LEFT JOIN cv_series cs ON cs.comicvine_id = s.cv_id
     WHERE ci.comicvine_id = ? LIMIT 1`).get(cvIssueId);
  if (!r || !r.series) return path.basename(String(filePath || 'comic' + ext));
  const clean = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '').trim();
  const nStr = r.issue_number != null && r.issue_number !== '' ? ` - #${clean(r.issue_number)}` : '';
  return `${clean(r.series)}${nStr}${ext}`;
}

// ---- feeds ------------------------------------------------------------------
export function opensearchDoc() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="${OPENSEARCH}">
  <ShortName>BackIssue</ShortName>
  <Description>Search the BackIssue comic library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="${NAV}" template="${BASE}/search?q={searchTerms}"/>
</OpenSearchDescription>`;
}

export function rootFeed({ hasReader = false } = {}) {
  const entry = (title, id, text, href, kind = NAV) => `  <entry>
    <title>${esc(title)}</title>
    <id>backissue:${esc(id)}</id>
    <updated>${now()}</updated>
    <content type="text">${esc(text)}</content>
    <link rel="subsection" href="${href}" type="${kind}"/>
  </entry>`;
  const entries = [
    entry('All series', 'opds:series', 'Every series with readable files', `${BASE}/series`),
    entry('Recently added', 'opds:recent', 'The latest issues added to the library', `${BASE}/recent`, ACQ),
    entry('Publishers', 'opds:publishers', 'Browse series by publisher', `${BASE}/publishers`),
  ];
  if (hasReader) {
    entries.push(entry('Continue reading', 'opds:continue', 'Pick up where you left off', `${BASE}/continue`, ACQ));
    entries.push(entry('Read later', 'opds:later', 'Your read-later shelf', `${BASE}/later`, ACQ));
  }
  // Point clients that prefer JSON at the OPDS 2.0 catalog.
  const alt = `  <link rel="alternate" href="${BASE}/v2" type="application/opds+json" title="OPDS 2.0 catalog"/>\n`;
  return head('opds', 'BackIssue', BASE, NAV) + alt + entries.join('\n') + '\n</feed>';
}

// Series entries shared by the all-series, search, and per-publisher feeds.
function seriesEntries(rows) {
  return rows.map((s) => `  <entry>
    <title>${esc(s.title)}${s.start_year ? esc(` (${s.start_year})`) : ''}</title>
    <id>backissue:opds:series:${s.id}</id>
    <updated>${now()}</updated>
    <content type="text">${s.issues} issue${s.issues === 1 ? '' : 's'} on the shelf</content>
${s.cover ? `    <link rel="http://opds-spec.org/image/thumbnail" href="${esc(s.cover)}"/>\n` : ''}    <link rel="subsection" href="${BASE}/series/${s.id}" type="${ACQ}"/>
  </entry>`).join('\n');
}

// Publisher facet links (inline filtering in OPDS clients). `active` marks the
// publisher currently being viewed.
function facetLinks(db, { includeRestricted, active = '' }) {
  const rows = publishers(db, { includeRestricted });
  if (!rows.length) return '';
  return rows.map((p) => `  <link rel="http://opds-spec.org/facet" href="${BASE}/publisher/${encodeURIComponent(p.publisher)}"`
    + ` title="${esc(`${p.publisher} (${p.count})`)}" opds:facetGroup="Publisher"${active === p.publisher ? ' opds:activeFacet="true"' : ''}/>`).join('\n') + '\n';
}

/** Paginated series list. `variant` picks the flavour:
 *  - {} → all series at /series
 *  - { search } → /search?q=…
 *  - { publisher } → /publisher/:name (adds the active facet) */
export function seriesNavFeed(db, opts = {}) {
  const { includeRestricted = true, search = '', publisher = '', page = 1 } = opts;
  const total = seriesCount(db, { includeRestricted, search, publisher });
  const rows = seriesRows(db, { includeRestricted, search, publisher, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  let self = `${BASE}/series`;
  let id = 'opds:series';
  let title = 'All series';
  if (search) { self = `${BASE}/search?q=${encodeURIComponent(search)}`; id = 'opds:search'; title = `Search: ${search}`; }
  else if (publisher) { self = `${BASE}/publisher/${encodeURIComponent(publisher)}`; id = `opds:publisher:${publisher}`; title = publisher; }
  return head(id, title, self, NAV)
    + pageLinks(self, NAV, page, PAGE_SIZE, total)
    + facetLinks(db, { includeRestricted, active: publisher })
    + seriesEntries(rows) + '\n</feed>';
}

export function publishersNavFeed(db, { includeRestricted = true } = {}) {
  const rows = publishers(db, { includeRestricted });
  const entries = rows.map((p) => `  <entry>
    <title>${esc(p.publisher)}</title>
    <id>backissue:opds:publisher:${esc(p.publisher)}</id>
    <updated>${now()}</updated>
    <content type="text">${p.count} series</content>
    <link rel="subsection" href="${BASE}/publisher/${encodeURIComponent(p.publisher)}" type="${NAV}"/>
  </entry>`).join('\n');
  return head('opds:publishers', 'Publishers', `${BASE}/publishers`, NAV) + entries + '\n</feed>';
}

// One acquisition entry per issue (download link + size, optional PSE stream
// and cover). Shared by the per-series and shelf acquisition feeds.
function issueEntry(i, { streaming, progress }) {
  const label = `#${i.issue_number ?? '?'}${i.title ? ` — ${i.title}` : ''}`;
  const updated = i.mtime ? new Date(i.mtime).toISOString().replace(/\.\d+Z$/, 'Z') : now();
  const links = [];
  if (streaming) {
    links.push(`    <link rel="http://opds-spec.org/image/thumbnail" href="${BASE}/issue/${i.cv_issue_id}/page/0?width=200" type="image/jpeg"/>`);
    links.push(`    <link rel="http://opds-spec.org/image" href="${BASE}/issue/${i.cv_issue_id}/page/0?width=800" type="image/jpeg"/>`);
  } else if (i.image_url) {
    links.push(`    <link rel="http://opds-spec.org/image/thumbnail" href="${esc(i.image_url)}"/>`);
    links.push(`    <link rel="http://opds-spec.org/image" href="${esc(i.image_url)}"/>`);
  }
  links.push(`    <link rel="http://opds-spec.org/acquisition" href="${BASE}/issue/${i.cv_issue_id}/file" type="${fileType(i.path)}"${i.size ? ` length="${i.size}"` : ''}/>`);
  if (streaming && i.page_count > 0) {
    // pse:lastRead (1-based per the PSE spec; our page index is 0-based) lets
    // PSE apps resume at the right page. Only stamped when there IS progress.
    const p = progress?.get(i.cv_issue_id);
    let pseExtra = '';
    if (p && (p.page > 0 || p.completed)) {
      const lastRead = p.completed ? i.page_count : Math.min(p.page + 1, i.page_count);
      const when = p.updated_at ? ` pse:lastReadDate="${esc(p.updated_at)}"` : '';
      pseExtra = ` pse:lastRead="${lastRead}"${when}`;
    }
    links.push(`    <link rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" href="${BASE}/issue/${i.cv_issue_id}/page/{pageNumber}?width={maxWidth}" pse:count="${i.page_count}"${pseExtra}/>`);
  }
  const summary = stripHtml(i.description);
  return `  <entry>
    <title>${esc(label)}</title>
    <id>backissue:opds:issue:${i.cv_issue_id}</id>
    <updated>${updated}</updated>
${i.cover_date ? `    <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${esc(i.cover_date)}</dc:date>\n` : ''}${i.publisher ? `    <category term="${esc(i.publisher)}" label="${esc(i.publisher)}"/>\n` : ''}${summary ? `    <summary type="text">${esc(summary)}</summary>\n` : ''}${links.join('\n')}
  </entry>`;
}

/** Acquisition feed for one series. `streaming` = the reader's page pipeline
 *  is loaded, enabling PSE links + our own cover/thumbnail routes. */
export function seriesAcqFeed(db, seriesId, { streaming = false, userId = null } = {}) {
  const title = seriesTitle(db, seriesId);
  if (title == null) return null;
  const rows = issueRows(db, seriesId);
  const progress = userId != null ? progressFor(db, userId, rows.map((r) => r.cv_issue_id)) : null;
  const entries = rows.map((i) => issueEntry(i, { streaming, progress })).join('\n');
  return head(`opds:series:${seriesId}`, title, `${BASE}/series/${seriesId}`, ACQ) + entries + '\n</feed>';
}

/** Acquisition feed from an arbitrary set of enriched issue rows (recently
 *  added, continue reading, read later). Pass `db` + `userId` to stamp
 *  pse:lastRead resume points on the stream links. */
export function issuesAcqFeed(rows, { id, title, self, streaming = false, db = null, userId = null } = {}) {
  const progress = db && userId != null ? progressFor(db, userId, (rows || []).map((r) => r.cv_issue_id)) : null;
  const entries = (rows || []).map((i) => issueEntry(i, { streaming, progress })).join('\n');
  return head(id, title, self, ACQ) + entries + '\n</feed>';
}
