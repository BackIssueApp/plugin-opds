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

export const OPDS2 = 'application/opds+json';
const V1 = '/api/opds';        // the 1.2 catalog (for alternate links)
const V2 = '/api/opds/v2';
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
export function rootDoc({ hasReader = false } = {}) {
  const nav = [
    { title: 'All series', href: `${V2}/series`, type: OPDS2, rel: 'subsection' },
    { title: 'Recently added', href: `${V2}/recent`, type: OPDS2, rel: 'subsection' },
    { title: 'Publishers', href: `${V2}/publishers`, type: OPDS2, rel: 'subsection' },
  ];
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
