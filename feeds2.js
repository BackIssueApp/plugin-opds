// OPDS 2.0 (JSON) renderer. OPDS 2.0 replaces the Atom/XML of 1.2 with a
// Readium-style JSON: a feed is { metadata, links, navigation?, publications?,
// facets? }. The *data* is identical to the 1.2 catalog — these builders reuse
// the exact same query functions from feeds.js and only change the shape, so
// the two catalogs never drift.
//
// Mapping: browse-only lists (root shelves, publishers) become `navigation`
// links; series and issues become `publications` (so covers show as tiles).
// A series publication carries a `subsection` link to its issue feed; an issue
// publication carries an acquisition (download) link. Whole-file downloads and
// PSE page images reuse the 1.2 routes under /api/opds/issue/… — nothing is
// duplicated.
import {
  seriesRows, seriesCount, publishers, issueRows, seriesTitle, fileType, stripHtml, PAGE_SIZE,
} from './feeds.js';
import {
  bookRows, bookCount, bookAuthors, bookSeries, ebookLibrariesList, multipleBookLibraries, bookMime, RECENT_ORDER,
} from './feeds-books.js';

export const OPDS2 = 'application/opds+json';
const V1 = '/api/opds';        // the 1.2 catalog (for alternate links)
const V2 = '/api/opds/v2';
const EB = '/api/ebooks';      // the ebooks plugin's own file + cover routes
const V1_NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ISO = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : undefined);

// Prev/next/first/last links for a paginated feed. `self` has no page param.
function pageLinks(self, page, size, total) {
  const sep = self.includes('?') ? '&' : '?';
  const url = (p) => `${self}${sep}page=${p}`;
  const last = Math.max(1, Math.ceil(total / size));
  const out = [{ rel: 'first', href: url(1), type: OPDS2 }];
  if (page > 1) out.push({ rel: 'previous', href: url(page - 1), type: OPDS2 });
  if (page < last) out.push({ rel: 'next', href: url(page + 1), type: OPDS2 });
  out.push({ rel: 'last', href: url(last), type: OPDS2 });
  return out;
}

// A series → a publication tile that opens its issue feed.
function seriesPublication(s) {
  return {
    metadata: {
      title: `${s.title}${s.start_year ? ` (${s.start_year})` : ''}`,
      identifier: `backissue:series:${s.id}`,
      description: `${s.issues} issue${s.issues === 1 ? '' : 's'} on the shelf`,
    },
    links: [{ rel: 'subsection', href: `${V2}/series/${s.id}`, type: OPDS2 }],
    images: s.cover ? [{ href: s.cover, type: 'image/jpeg' }] : undefined,
  };
}

// An issue → an acquirable publication (download link + cover).
function issuePublication(i, { streaming }) {
  const images = streaming
    ? [
        { href: `${V1}/issue/${i.cv_issue_id}/page/0?width=800`, type: 'image/jpeg' },
        { href: `${V1}/issue/${i.cv_issue_id}/page/0?width=200`, type: 'image/jpeg' },
      ]
    : (i.image_url ? [{ href: i.image_url, type: 'image/jpeg' }] : undefined);
  return {
    metadata: {
      title: `#${i.issue_number ?? '?'}${i.title ? ` — ${i.title}` : ''}`,
      identifier: `backissue:issue:${i.cv_issue_id}`,
      modified: ISO(i.mtime),
      published: i.cover_date || undefined,
      publisher: i.publisher || undefined,
      description: stripHtml(i.description) || undefined,
      numberOfPages: i.page_count || undefined,
    },
    links: [{
      rel: 'http://opds-spec.org/acquisition',
      href: `${V1}/issue/${i.cv_issue_id}/file`,
      type: fileType(i.path),
      properties: i.size ? { size: i.size } : undefined,
    }],
    images,
  };
}

// Publisher facet group for the series list.
function facets(db, { includeRestricted, active = '' }) {
  const rows = publishers(db, { includeRestricted });
  if (!rows.length) return undefined;
  return [{
    metadata: { title: 'Publisher' },
    links: rows.map((p) => ({
      title: `${p.publisher} (${p.count})`,
      href: `${V2}/publisher/${encodeURIComponent(p.publisher)}`,
      type: OPDS2,
      properties: active === p.publisher ? { active: true } : undefined,
    })),
  }];
}

// ---- feeds ------------------------------------------------------------------
export function rootDoc({ hasReader = false, hasBooks = false } = {}) {
  const nav = [
    { title: 'All series', href: `${V2}/series`, type: OPDS2, rel: 'subsection' },
    { title: 'Recently added', href: `${V2}/recent`, type: OPDS2, rel: 'subsection' },
    { title: 'Publishers', href: `${V2}/publishers`, type: OPDS2, rel: 'subsection' },
  ];
  if (hasBooks) nav.push({ title: 'Books', href: `${V2}/books`, type: OPDS2, rel: 'subsection' });
  if (hasReader) {
    nav.push({ title: 'Continue reading', href: `${V2}/continue`, type: OPDS2, rel: 'subsection' });
    nav.push({ title: 'Read later', href: `${V2}/later`, type: OPDS2, rel: 'subsection' });
  }
  return {
    metadata: { title: 'BackIssue' },
    links: [
      { rel: 'self', href: V2, type: OPDS2 },
      { rel: 'search', href: `${V2}/search{?query}`, type: OPDS2, templated: true },
      { rel: 'alternate', href: V1, type: V1_NAV, title: 'OPDS 1.2 catalog' },
    ],
    navigation: nav,
  };
}

/** Paginated series list. `variant`: {} → /series, { search } → /search,
 *  { publisher } → /publisher/:name. */
export function seriesDoc(db, opts = {}) {
  const { includeRestricted = true, search = '', publisher = '', page = 1 } = opts;
  const total = seriesCount(db, { includeRestricted, search, publisher });
  const rows = seriesRows(db, { includeRestricted, search, publisher, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  let self = `${V2}/series`;
  let title = 'All series';
  if (search) { self = `${V2}/search?query=${encodeURIComponent(search)}`; title = `Search: ${search}`; }
  else if (publisher) { self = `${V2}/publisher/${encodeURIComponent(publisher)}`; title = publisher; }
  return {
    metadata: { title, numberOfItems: total, itemsPerPage: PAGE_SIZE, currentPage: page },
    links: [{ rel: 'self', href: self, type: OPDS2 }, ...pageLinks(self, page, PAGE_SIZE, total)],
    facets: facets(db, { includeRestricted, active: publisher }),
    publications: rows.map(seriesPublication),
  };
}

export function publishersDoc(db, { includeRestricted = true } = {}) {
  const rows = publishers(db, { includeRestricted });
  return {
    metadata: { title: 'Publishers', numberOfItems: rows.length },
    links: [{ rel: 'self', href: `${V2}/publishers`, type: OPDS2 }],
    navigation: rows.map((p) => ({
      title: `${p.publisher} (${p.count})`,
      href: `${V2}/publisher/${encodeURIComponent(p.publisher)}`,
      type: OPDS2,
      rel: 'subsection',
    })),
  };
}

/** Issue feed (series detail, recent, continue, later) from enriched rows. */
export function issuesDoc(rows, { title, self, streaming = false } = {}) {
  return {
    metadata: { title, numberOfItems: (rows || []).length },
    links: [{ rel: 'self', href: self, type: OPDS2 }],
    publications: (rows || []).map((i) => issuePublication(i, { streaming })),
  };
}

/** Series detail (its issues) as an OPDS 2.0 feed, or null if unknown. */
export function seriesIssuesDoc(db, seriesId, { streaming = false } = {}) {
  const title = seriesTitle(db, seriesId);
  if (title == null) return null;
  return issuesDoc(issueRows(db, seriesId), { title, self: `${V2}/series/${seriesId}`, streaming });
}

// ---- ebooks (EPUB/PDF) — the same book queries, JSON shape. ---------------
// Whole-book downloads and covers reuse the ebooks plugin's own routes under
// /api/ebooks/…, identical to the 1.2 catalog — nothing is duplicated.

// A book (ebook issue) → an acquirable publication (download link + cover).
function bookPublication(b) {
  const multi = b.series_count > 1 && b.series_title;
  const pos = `#${b.issue_number ?? '?'}`;
  const authors = String(b.author || '').split(',').map((a) => a.trim()).filter(Boolean);
  return {
    metadata: {
      title: multi ? `${b.series_title} ${pos}${b.title && b.title !== b.series_title ? ` — ${b.title}` : ''}` : (b.title || 'Untitled'),
      identifier: b.isbn ? `urn:isbn:${b.isbn}` : `backissue:book:${b.issue_id}`,
      author: authors.length ? authors.map((name) => ({ name })) : undefined,
      language: b.language || undefined,
      published: b.year || undefined,
      modified: b.added_at || undefined,
      belongsTo: multi ? { series: { name: b.series_title, position: Number(b.issue_number) || undefined } } : undefined,
      description: multi ? undefined : (stripHtml(b.series_description) || undefined),
    },
    links: [{
      rel: 'http://opds-spec.org/acquisition',
      href: `${EB}/issue/${b.issue_id}/file?dl=1`,
      type: bookMime(b.format),
      properties: b.size ? { size: b.size } : undefined,
    }],
    images: [{ href: `${EB}/issue/${b.issue_id}/cover` }],
  };
}

function booksListDoc(rows, { title, self, total = null, page = 1 }) {
  const links = [{ rel: 'self', href: self, type: OPDS2 }];
  if (total != null) links.push(...pageLinks(self, page, PAGE_SIZE, total));
  return {
    metadata: { title, numberOfItems: total ?? (rows || []).length, itemsPerPage: PAGE_SIZE, currentPage: page },
    links,
    publications: (rows || []).map(bookPublication),
  };
}

export function booksRootDoc(db, { includeRestricted = true } = {}) {
  const nav = [
    { title: 'All books', href: `${V2}/books/all`, type: OPDS2, rel: 'subsection' },
    { title: 'Recently added', href: `${V2}/books/recent`, type: OPDS2, rel: 'subsection' },
    { title: 'By author', href: `${V2}/books/authors`, type: OPDS2, rel: 'subsection' },
    { title: 'By series', href: `${V2}/books/series`, type: OPDS2, rel: 'subsection' },
  ];
  if (multipleBookLibraries(db, { includeRestricted })) {
    nav.push({ title: 'Libraries', href: `${V2}/books/libraries`, type: OPDS2, rel: 'subsection' });
  }
  return { metadata: { title: 'Books' }, links: [{ rel: 'self', href: `${V2}/books`, type: OPDS2 }], navigation: nav };
}

export function allBooksDoc(db, { includeRestricted = true, page = 1 } = {}) {
  const total = bookCount(db, { includeRestricted });
  const rows = bookRows(db, { includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return booksListDoc(rows, { title: 'All books', self: `${V2}/books/all`, total, page });
}

export function recentBooksDoc(db, { includeRestricted = true } = {}) {
  const rows = bookRows(db, { includeRestricted, order: RECENT_ORDER, limit: PAGE_SIZE });
  return booksListDoc(rows, { title: 'Recently added books', self: `${V2}/books/recent` });
}

// Paged like the 1.2 feeds: tens of thousands of authors on a big catalog.
export function bookAuthorsDoc(db, { includeRestricted = true, page = 1 } = {}) {
  const all = bookAuthors(db, { includeRestricted });
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const self = `${V2}/books/authors`;
  return {
    metadata: { title: 'Books by author', numberOfItems: all.length, itemsPerPage: PAGE_SIZE, currentPage: page },
    links: [{ rel: 'self', href: self, type: OPDS2 }, ...pageLinks(self, page, PAGE_SIZE, all.length)],
    navigation: rows.map((a) => ({
      title: `${a.author} (${a.count})`, href: `${V2}/books/author/${encodeURIComponent(a.author)}`, type: OPDS2, rel: 'subsection',
    })),
  };
}

export function booksByAuthorDoc(db, author, { includeRestricted = true, page = 1 } = {}) {
  const base = { conds: ['s.publisher = ?'], params: [author] };
  const total = bookCount(db, { ...base, includeRestricted });
  const rows = bookRows(db, { ...base, includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return booksListDoc(rows, { title: author, self: `${V2}/books/author/${encodeURIComponent(author)}`, total, page });
}

export function bookSeriesDoc(db, { includeRestricted = true, page = 1 } = {}) {
  const all = bookSeries(db, { includeRestricted });
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const self = `${V2}/books/series`;
  return {
    metadata: { title: 'Book series', numberOfItems: all.length, itemsPerPage: PAGE_SIZE, currentPage: page },
    links: [{ rel: 'self', href: self, type: OPDS2 }, ...pageLinks(self, page, PAGE_SIZE, all.length)],
    navigation: rows.map((s) => ({
      title: `${s.title}${s.year ? ` (${s.year})` : ''} (${s.count})`, href: `${V2}/books/series/${s.id}`, type: OPDS2, rel: 'subsection',
    })),
  };
}

export function booksBySeriesDoc(db, seriesId, { includeRestricted = true } = {}) {
  const rows = bookRows(db, {
    conds: ['s.id = ?'], params: [Number(seriesId)], includeRestricted, limit: 10000,
    order: 'ORDER BY CAST(i.issue_number AS REAL), i.issue_number COLLATE NOCASE',
  });
  if (!rows.length) return null;
  return booksListDoc(rows, { title: rows[0].series_title, self: `${V2}/books/series/${seriesId}` });
}

export function bookLibrariesDoc(db, { includeRestricted = true } = {}) {
  const rows = ebookLibrariesList(db, { includeRestricted });
  return {
    metadata: { title: 'Book libraries', numberOfItems: rows.length },
    links: [{ rel: 'self', href: `${V2}/books/libraries`, type: OPDS2 }],
    navigation: rows.map((l) => ({
      title: `${l.name} (${l.count})`, href: `${V2}/books/library/${l.id}`, type: OPDS2, rel: 'subsection',
    })),
  };
}

export function booksByLibraryDoc(db, libId, { includeRestricted = true, page = 1 } = {}) {
  const base = { conds: ['s.library_id = ?'], params: [Number(libId)] };
  const total = bookCount(db, { ...base, includeRestricted });
  if (!total) return null;
  const rows = bookRows(db, { ...base, includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  let name = 'Books';
  try { name = db.prepare('SELECT name FROM libraries WHERE id = ?').get(Number(libId))?.name || name; } catch { /* older core */ }
  return booksListDoc(rows, { title: name, self: `${V2}/books/library/${libId}`, total, page });
}

export function booksSearchDoc(db, { search = '', includeRestricted = true, page = 1 } = {}) {
  const like = `%${search}%`;
  const base = { conds: ['(i.title LIKE ? OR s.title LIKE ? OR s.publisher LIKE ?)'], params: [like, like, like] };
  const total = bookCount(db, { ...base, includeRestricted });
  const rows = bookRows(db, { ...base, includeRestricted, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return booksListDoc(rows, { title: `Book search: ${search}`, self: `${V2}/books/search?query=${encodeURIComponent(search)}`, total, page });
}
