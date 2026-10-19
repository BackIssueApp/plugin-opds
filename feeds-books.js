// OPDS 1.2 feed builders for the EBOOK (EPUB/PDF) library — a branch parallel
// to the comic feeds in feeds.js, sharing its XML helpers but with its own
// queries and no ComicVine/PSE machinery.
//
// A "book" is one ebook issue: a standalone book is a single-issue,
// self-described series; a calibre series groups its books as issues ordered by
// series index. Books are found by `series.type='ebook'` joined to the ebooks
// plugin's `ebooks_files` table (format / isbn / language / size) — NOT the
// comic `library_files` join — so FILE-LESS on-demand books (path NULL) are
// included: their acquisition link points at the ebooks plugin's file route,
// which materializes the download on first read.
//
// Soft dependency: every query first checks that `ebooks_files` exists and is
// wrapped in try/catch, so on a catalog without the ebooks plugin the whole
// branch yields nothing (the catalog degrades to comics-only) and never errors.
import { esc, stripHtml, head, pageLinks, now, memo, NAV, ACQ, PAGE_SIZE } from './feeds.js';

const BASE = '/api/opds';
const EB = '/api/ebooks'; // the ebooks plugin's own file + cover routes
const OSD = 'application/opensearchdescription+xml';

const BOOK_MIME = { epub: 'application/epub+zip', pdf: 'application/pdf' };
export const bookMime = (fmt) => BOOK_MIME[String(fmt || '').toLowerCase()] || 'application/octet-stream';

// Feed header wired to the BOOK search descriptor (so a reader's search box
// searches books, not comics, while browsing this branch).
const bhead = (id, title, self, kind) => head(id, title, self, kind, `${BASE}/books/opensearch.xml`);

// Does the ebooks plugin's table exist on this catalog?
export function hasEbookTables(db) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ebooks_files' LIMIT 1").get();
  } catch { return false; }
}

// ---- queries ----------------------------------------------------------------
// One row per book (ebook issue), carrying everything an acquisition entry
// needs. series_count distinguishes a standalone (1) from a calibre series (>1).
const BOOK_SELECT = `
  SELECT i.id AS issue_id, i.title AS title, i.issue_number,
         s.id AS series_id, s.title AS series_title,
         s.publisher AS author, s.year, s.description AS series_description, s.library_id,
         ef.format, ef.isbn, ef.language, ef.size, ef.added_at,
         (SELECT COUNT(*) FROM issues i2 WHERE i2.series_id = s.id) AS series_count
    FROM series s
    JOIN issues i ON i.series_id = s.id
    JOIN ebooks_files ef ON ef.issue_id = i.id
   WHERE s.type = 'ebook'`;

// The on-demand catalog can hold hundreds of thousands of books, so a feed
// page is found in two steps: the ordered list of matching ebooks_files rows
// (narrow — no descriptions, no per-row series count), kept for a minute so
// paging and the total share it, then the full rows for just that page.
// "Recently added" walks the ebooks plugin's added_at index instead and never
// builds the list.
export const RECENT_ORDER = 'ORDER BY ef.added_at DESC, i.id DESC';
const restrictedCond = (includeRestricted) => (includeRestricted ? [] : ['s.restricted = 0']);

function bookRowIds(db, { conds = [], params = [], order, includeRestricted = true }) {
  const c = [...conds, ...restrictedCond(includeRestricted)];
  const where = c.length ? ' AND ' + c.join(' AND ') : '';
  const key = `books|${where}|${JSON.stringify(params)}|${order}`;
  return memo(db, key, () => {
    const st = db.prepare(`SELECT ef.rowid, i.title AS title
      FROM series s JOIN issues i ON i.series_id = s.id JOIN ebooks_files ef ON ef.issue_id = i.id
      WHERE s.type = 'ebook'${where} ${order}, ef.rowid`).raw();
    const out = [];
    for (const r of st.iterate(...params)) out.push(r[0]);
    return Int32Array.from(out);
  });
}

function recentRowIds(db, { conds = [], params = [], limit, offset, includeRestricted }) {
  const c = ["s.type = 'ebook'", ...conds, ...restrictedCond(includeRestricted)];
  return db.prepare(`SELECT ef.rowid FROM ebooks_files ef
    WHERE EXISTS (SELECT 1 FROM issues i JOIN series s ON s.id = i.series_id
                   WHERE i.id = ef.issue_id AND ${c.join(' AND ')})
    ORDER BY ef.added_at DESC, ef.issue_id DESC LIMIT ? OFFSET ?`).raw().all(...params, limit, offset).map((r) => r[0]);
}

export function bookRows(db, { conds = [], params = [], order = 'ORDER BY title COLLATE NOCASE', limit = PAGE_SIZE, offset = 0, includeRestricted = true } = {}) {
  if (!hasEbookTables(db)) return [];
  try {
    const ids = order === RECENT_ORDER
      ? recentRowIds(db, { conds, params, limit, offset, includeRestricted })
      : [...bookRowIds(db, { conds, params, order, includeRestricted }).subarray(offset, offset + limit)];
    if (!ids.length) return [];
    const pos = new Map(ids.map((id, n) => [id, n]));
    return db.prepare(`${BOOK_SELECT.replace('SELECT', 'SELECT ef.rowid AS _rid,')} AND ef.rowid IN (${ids.map(() => '?').join(',')})`)
      .all(...ids)
      .sort((a, b) => pos.get(a._rid) - pos.get(b._rid))
      .map(({ _rid, ...row }) => row);
  } catch { return []; }
}

export function bookCount(db, { conds = [], params = [], includeRestricted = true } = {}) {
  if (!hasEbookTables(db)) return 0;
  try { return bookRowIds(db, { conds, params, order: 'ORDER BY title COLLATE NOCASE', includeRestricted }).length; }
  catch { return 0; }
}

/** Is at least one book visible? (The root menus only need yes/no.) */
export function hasBooks(db, { includeRestricted = true } = {}) {
  if (!hasEbookTables(db)) return false;
  try {
    return !!db.prepare(`SELECT 1 FROM series s
      WHERE s.type = 'ebook'${includeRestricted ? '' : ' AND s.restricted = 0'}
        AND EXISTS (SELECT 1 FROM issues i JOIN ebooks_files ef ON ef.issue_id = i.id WHERE i.series_id = s.id)
      LIMIT 1`).get();
  } catch { return false; }
}

// Every book row joined from ebooks_files outward (one pass, no Bloom filter
// over the series table), for the grouped lists below.
const FROM_FILES = `FROM ebooks_files ef CROSS JOIN issues i ON i.id = ef.issue_id
  CROSS JOIN series s ON s.id = i.series_id WHERE s.type = 'ebook'`;

// Author bylines (series.publisher slot) with a book count, for the "By author"
// browse. Grouped by the whole byline string, mirroring the comic publisher
// facet.
export function bookAuthors(db, { includeRestricted = true } = {}) {
  if (!hasEbookTables(db)) return [];
  const restr = includeRestricted ? '' : ' AND s.restricted = 0';
  try {
    return memo(db, `book-authors|${restr}`, () => db.prepare(`SELECT s.publisher AS author, COUNT(*) AS count
      ${FROM_FILES} AND s.publisher IS NOT NULL AND s.publisher <> ''${restr}
      GROUP BY s.publisher ORDER BY s.publisher COLLATE NOCASE`).all());
  } catch { return []; }
}

// Multi-book (calibre) series only — a "By series" browse of standalone
// single-book series would just be noise, so require >= 2 books.
export function bookSeries(db, { includeRestricted = true } = {}) {
  if (!hasEbookTables(db)) return [];
  const restr = includeRestricted ? '' : ' AND s.restricted = 0';
  try {
    return memo(db, `book-series|${restr}`, () => db.prepare(`SELECT s.id, s.title, s.year, COUNT(*) AS count
      FROM series s JOIN issues i ON i.series_id = s.id JOIN ebooks_files ef ON ef.issue_id = i.id
      WHERE s.type = 'ebook'${restr}
      GROUP BY s.id HAVING COUNT(*) >= 2 ORDER BY s.title COLLATE NOCASE`).all());
  } catch { return []; }
}

// Ebook libraries that actually contain books, with counts (for the per-library
// browse, shown only when more than one exists).
export function ebookLibrariesList(db, { includeRestricted = true } = {}) {
  if (!hasEbookTables(db)) return [];
  const restr = includeRestricted ? '' : ' AND s.restricted = 0';
  try {
    return memo(db, `book-libraries|${restr}`, () => db.prepare(`SELECT l.id, l.name, c.count
      FROM (SELECT s.library_id AS lid, COUNT(*) AS count ${FROM_FILES}${restr} GROUP BY s.library_id) c
      JOIN libraries l ON l.id = c.lid
      ORDER BY l.name COLLATE NOCASE`).all());
  } catch { return []; }
}

/** More than one ebook library with books in it? (The Books menu only shows
 *  the Libraries entry then.) A per-library existence probe, not a count. */
export function multipleBookLibraries(db, { includeRestricted = true } = {}) {
  if (!hasEbookTables(db)) return false;
  const restr = includeRestricted ? '' : ' AND s.restricted = 0';
  try {
    return db.prepare(`SELECT l.id FROM libraries l WHERE EXISTS (
        SELECT 1 FROM series s JOIN issues i ON i.series_id = s.id JOIN ebooks_files ef ON ef.issue_id = i.id
         WHERE s.library_id = l.id AND s.type = 'ebook'${restr}) LIMIT 2`).all().length > 1;
  } catch { return false; }
}

// ---- entry + feeds ----------------------------------------------------------
// One acquisition entry per book: title (series + position for a calibre
// series), authors, language/ISBN identifiers, cover, and the download link.
function bookEntry(b) {
  const multi = b.series_count > 1 && b.series_title;
  const pos = `#${b.issue_number ?? '?'}`;
  const title = multi
    ? `${b.series_title} ${pos}${b.title && b.title !== b.series_title ? ` — ${b.title}` : ''}`
    : (b.title || 'Untitled');
  const updated = b.added_at ? String(b.added_at).replace(/\.\d+Z$/, 'Z') : now();
  const authors = String(b.author || '').split(',').map((a) => a.trim()).filter(Boolean);
  // A standalone book's blurb is on its series row; a calibre member has none.
  const summary = multi ? '' : stripHtml(b.series_description);
  const mime = bookMime(b.format);
  const L = [];
  L.push(`    <title>${esc(title)}</title>`);
  L.push(`    <id>backissue:opds:book:${b.issue_id}</id>`);
  L.push(`    <updated>${updated}</updated>`);
  for (const a of authors) L.push(`    <author><name>${esc(a)}</name></author>`);
  if (b.year) L.push(`    <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${esc(b.year)}</dc:date>`);
  if (b.language) L.push(`    <dcterms:language xmlns:dcterms="http://purl.org/dc/terms/">${esc(b.language)}</dcterms:language>`);
  if (b.isbn) L.push(`    <dcterms:identifier xmlns:dcterms="http://purl.org/dc/terms/">urn:isbn:${esc(b.isbn)}</dcterms:identifier>`);
  if (multi) L.push(`    <category term="${esc(b.series_title)}" label="${esc(`${b.series_title} ${pos}`)}"/>`);
  if (summary) L.push(`    <summary type="text">${esc(summary)}</summary>`);
  L.push(`    <link rel="http://opds-spec.org/image/thumbnail" href="${EB}/issue/${b.issue_id}/cover"/>`);
  L.push(`    <link rel="http://opds-spec.org/image" href="${EB}/issue/${b.issue_id}/cover"/>`);
  L.push(`    <link rel="http://opds-spec.org/acquisition" href="${EB}/issue/${b.issue_id}/file?dl=1" type="${mime}"${b.size ? ` length="${b.size}"` : ''}/>`);
  return `  <entry>\n${L.join('\n')}\n  </entry>`;
}

// Shared acquisition feed from book rows (+ optional paging).
function booksAcqFeed(rows, { id, title, self, page = null, total = null } = {}) {
  const paging = (page != null && total != null) ? pageLinks(self, ACQ, page, PAGE_SIZE, total) : '';
  const entries = (rows || []).map(bookEntry).join('\n');
  return bhead(id, title, self, ACQ) + paging + entries + '\n</feed>';
}

// The Books submenu (top level of the ebook branch).
export function booksRootNavFeed(db, { includeRestricted = true } = {}) {
  const entry = (title, id, text, href, kind = NAV) => `  <entry>
    <title>${esc(title)}</title>
    <id>backissue:${esc(id)}</id>
    <updated>${now()}</updated>
    <content type="text">${esc(text)}</content>
    <link rel="subsection" href="${href}" type="${kind}"/>
  </entry>`;
  const entries = [
    entry('All books', 'opds:books:all', 'Every book, A–Z', `${BASE}/books/all`, ACQ),
    entry('Recently added', 'opds:books:recent', 'The latest books added', `${BASE}/books/recent`, ACQ),
    entry('By author', 'opds:books:authors', 'Browse books by author', `${BASE}/books/authors`),
    entry('By series', 'opds:books:series', 'Browse multi-book series', `${BASE}/books/series`),
  ];
  if (multipleBookLibraries(db, { includeRestricted })) {
    entries.push(entry('Libraries', 'opds:books:libraries', 'Browse by book library', `${BASE}/books/libraries`));
  }
  return bhead('opds:books', 'Books', `${BASE}/books`, NAV) + entries.join('\n') + '\n</feed>';
}

export function allBooksFeed(db, { includeRestricted = true, page = 1 } = {}) {
  const total = bookCount(db, { includeRestricted });
  const rows = bookRows(db, { includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return booksAcqFeed(rows, { id: 'opds:books:all', title: 'All books', self: `${BASE}/books/all`, page, total });
}

export function recentBooksFeed(db, { includeRestricted = true } = {}) {
  const rows = bookRows(db, { includeRestricted, order: RECENT_ORDER, limit: PAGE_SIZE });
  return booksAcqFeed(rows, { id: 'opds:books:recent', title: 'Recently added books', self: `${BASE}/books/recent` });
}

// The author and series lists run to tens of thousands of entries on a big
// catalog, so they are paged like every other list.
export function bookAuthorsNavFeed(db, { includeRestricted = true, page = 1 } = {}) {
  const all = bookAuthors(db, { includeRestricted });
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const entries = rows.map((a) => `  <entry>
    <title>${esc(a.author)}</title>
    <id>backissue:opds:books:author:${esc(a.author)}</id>
    <updated>${now()}</updated>
    <content type="text">${a.count} book${a.count === 1 ? '' : 's'}</content>
    <link rel="subsection" href="${BASE}/books/author/${encodeURIComponent(a.author)}" type="${ACQ}"/>
  </entry>`).join('\n');
  const self = `${BASE}/books/authors`;
  return bhead('opds:books:authors', 'Books by author', self, NAV)
    + pageLinks(self, NAV, page, PAGE_SIZE, all.length) + entries + '\n</feed>';
}

export function booksByAuthorFeed(db, author, { includeRestricted = true, page = 1 } = {}) {
  const base = { conds: ['s.publisher = ?'], params: [author] };
  const total = bookCount(db, { ...base, includeRestricted });
  const rows = bookRows(db, { ...base, includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return booksAcqFeed(rows, { id: `opds:books:author:${author}`, title: author, self: `${BASE}/books/author/${encodeURIComponent(author)}`, page, total });
}

export function bookSeriesNavFeed(db, { includeRestricted = true, page = 1 } = {}) {
  const all = bookSeries(db, { includeRestricted });
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const entries = rows.map((s) => `  <entry>
    <title>${esc(s.title)}${s.year ? esc(` (${s.year})`) : ''}</title>
    <id>backissue:opds:books:series:${s.id}</id>
    <updated>${now()}</updated>
    <content type="text">${s.count} book${s.count === 1 ? '' : 's'}</content>
    <link rel="subsection" href="${BASE}/books/series/${s.id}" type="${ACQ}"/>
  </entry>`).join('\n');
  const self = `${BASE}/books/series`;
  return bhead('opds:books:series', 'Book series', self, NAV)
    + pageLinks(self, NAV, page, PAGE_SIZE, all.length) + entries + '\n</feed>';
}

// A calibre series' books, ordered by series index (issue number). null when
// the series is unknown, not an ebook series, or hidden by restriction → 404.
export function booksBySeriesFeed(db, seriesId, { includeRestricted = true } = {}) {
  const rows = bookRows(db, {
    conds: ['s.id = ?'], params: [Number(seriesId)], includeRestricted, limit: 10000, offset: 0,
    order: 'ORDER BY CAST(i.issue_number AS REAL), i.issue_number COLLATE NOCASE',
  });
  if (!rows.length) return null;
  return booksAcqFeed(rows, { id: `opds:books:series:${seriesId}`, title: rows[0].series_title, self: `${BASE}/books/series/${seriesId}` });
}

export function bookLibrariesNavFeed(db, { includeRestricted = true } = {}) {
  const rows = ebookLibrariesList(db, { includeRestricted });
  const entries = rows.map((l) => `  <entry>
    <title>${esc(l.name)}</title>
    <id>backissue:opds:books:library:${l.id}</id>
    <updated>${now()}</updated>
    <content type="text">${l.count} book${l.count === 1 ? '' : 's'}</content>
    <link rel="subsection" href="${BASE}/books/library/${l.id}" type="${ACQ}"/>
  </entry>`).join('\n');
  return bhead('opds:books:libraries', 'Book libraries', `${BASE}/books/libraries`, NAV) + entries + '\n</feed>';
}

export function booksByLibraryFeed(db, libId, { includeRestricted = true, page = 1 } = {}) {
  const base = { conds: ['s.library_id = ?'], params: [Number(libId)] };
  const total = bookCount(db, { ...base, includeRestricted });
  if (!total) return null;
  const rows = bookRows(db, { ...base, includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  let name = 'Books';
  try { name = db.prepare('SELECT name FROM libraries WHERE id = ?').get(Number(libId))?.name || name; } catch { /* older core */ }
  return booksAcqFeed(rows, { id: `opds:books:library:${libId}`, title: name, self: `${BASE}/books/library/${libId}`, page, total });
}

// Book-scoped search (title, series, or author), paginated.
export function booksSearchFeed(db, { search = '', includeRestricted = true, page = 1 } = {}) {
  const like = `%${search}%`;
  const base = { conds: ['(i.title LIKE ? OR s.title LIKE ? OR s.publisher LIKE ?)'], params: [like, like, like] };
  const total = bookCount(db, { ...base, includeRestricted });
  const rows = bookRows(db, { ...base, includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return booksAcqFeed(rows, { id: 'opds:books:search', title: `Book search: ${search}`, self: `${BASE}/books/search?q=${encodeURIComponent(search)}`, page, total });
}

export function booksOpensearchDoc() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>BackIssue Books</ShortName>
  <Description>Search the BackIssue ebook library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="${ACQ}" template="${BASE}/books/search?q={searchTerms}"/>
</OpenSearchDescription>`;
}

// So callers can advertise the descriptor's content type without re-deriving it.
export const BOOKS_OSD_TYPE = OSD;
