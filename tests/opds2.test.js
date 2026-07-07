// OPDS 2.0 (JSON) renderer over the shared catalog queries: navigation vs
// publications mapping, cover images, acquisition links, pagination metadata,
// publisher facets, search, and restricted filtering. Reuses the same seeded
// catalog shape as the 1.2 tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  rootDoc, seriesDoc, publishersDoc, issuesDoc, seriesIssuesDoc, OPDS2,
} from '../feeds2.js';
import { recentIssues, issuesByIds } from '../feeds.js';

function seededDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT, cv_id INTEGER, cover_url TEXT,
      publisher TEXT, restricted INTEGER DEFAULT 0);
    CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT, start_year TEXT,
      image_url TEXT, publisher TEXT);
    CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, issue_number TEXT,
      name TEXT, cover_date TEXT, description TEXT, image_url TEXT);
    CREATE TABLE library_files (path TEXT PRIMARY KEY, series_id INTEGER, cv_issue_id INTEGER,
      valid INTEGER DEFAULT 1, has_metadata INTEGER DEFAULT 0, page_count INTEGER, mtime INTEGER, size INTEGER);

    INSERT INTO series VALUES (1,'Saga & Friends',900,NULL,'Image',0),(3,'Batman',700,NULL,'DC',0),(4,'Crossed',800,NULL,'Avatar',1);
    INSERT INTO cv_series VALUES (900,'Saga & Friends','2012','https://img/900.jpg','Image'),(700,'Batman','2016',NULL,'DC'),(800,'Crossed','2008',NULL,'Avatar');
    INSERT INTO cv_issues VALUES
      (101,900,'1','Chapter <One>','2012-03-01','<p>The <b>first</b> issue.</p>','https://img/i101.jpg'),
      (102,900,'2',NULL,'2012-04-01',NULL,NULL),
      (201,700,'1','Year One','2016-06-01',NULL,NULL),
      (301,800,'1','Patient Zero','2008-01-01',NULL,NULL);
    INSERT INTO library_files VALUES
      ('/lib/saga1.cbz',1,101,1,1,22,1700000000000,5000),
      ('/lib/saga2.pdf',1,102,1,1,NULL,1700000200000,7000),
      ('/lib/batman1.cbz',3,201,1,1,40,1800000000000,8000),
      ('/lib/crossed1.cbz',4,301,1,1,25,1750000000000,9000);
  `);
  return db;
}

test('root doc: navigation shelves, templated search, alternate to 1.2', () => {
  const root = rootDoc({ hasReader: false });
  assert.equal(root.metadata.title, 'BackIssue');
  assert.ok(root.links.some((l) => l.rel === 'self' && l.type === OPDS2));
  const search = root.links.find((l) => l.rel === 'search');
  assert.equal(search.templated, true);
  assert.match(search.href, /\{\?query\}$/);
  assert.ok(root.links.some((l) => l.rel === 'alternate' && l.href === '/api/opds'), 'links to the 1.2 catalog');
  assert.deepEqual(root.navigation.map((n) => n.title), ['All series', 'Recently added', 'Publishers']);
  assert.ok(rootDoc({ hasReader: true }).navigation.some((n) => n.title === 'Continue reading'));
});

test('series doc: publications with covers + subsection links, facets, pagination', () => {
  const db = seededDb();
  const doc = seriesDoc(db);
  assert.equal(doc.metadata.numberOfItems, 3);
  assert.equal(doc.metadata.itemsPerPage, 50);
  // series render as publications (tiles), ordered A–Z
  assert.deepEqual(doc.publications.map((p) => p.metadata.title), ['Batman (2016)', 'Crossed (2008)', 'Saga & Friends (2012)']);
  const saga = doc.publications.find((p) => p.metadata.title.startsWith('Saga'));
  assert.equal(saga.images[0].href, 'https://img/900.jpg');
  assert.equal(saga.links[0].rel, 'subsection');
  assert.equal(saga.links[0].href, '/api/opds/v2/series/1');
  // publisher facet group present, with counts
  const grp = doc.facets.find((f) => f.metadata.title === 'Publisher');
  assert.ok(grp.links.some((l) => l.title === 'DC (1)'));
  // self + first/last paging links
  assert.ok(doc.links.some((l) => l.rel === 'self'));
  assert.ok(doc.links.some((l) => l.rel === 'last'));
});

test('series doc: search filters, restricted hidden, active facet marked', () => {
  const db = seededDb();
  const hit = seriesDoc(db, { search: 'saga' });
  assert.equal(hit.metadata.numberOfItems, 1);
  assert.equal(hit.publications[0].metadata.title, 'Saga & Friends (2012)');

  // mature (Crossed) hidden for a role without permission
  const safe = seriesDoc(db, { includeRestricted: false });
  assert.ok(!safe.publications.some((p) => p.metadata.title === 'Crossed'));

  const dc = seriesDoc(db, { publisher: 'DC' });
  assert.deepEqual(dc.publications.map((p) => p.metadata.title), ['Batman (2016)']);
  const grp = dc.facets.find((f) => f.metadata.title === 'Publisher');
  assert.ok(grp.links.find((l) => l.title === 'DC (1)').properties.active, 'active facet flagged');
});

test('issue publications: acquisition link + size, cover fallback, PSE cover when streaming', () => {
  const db = seededDb();
  const doc = seriesIssuesDoc(db, 1, { streaming: false });
  assert.equal(doc.metadata.title, 'Saga & Friends');
  const one = doc.publications.find((p) => p.metadata.identifier === 'backissue:issue:101');
  assert.equal(one.metadata.title, '#1 — Chapter <One>'); // JSON needs no XML escaping
  assert.equal(one.metadata.description, 'The first issue.'); // HTML stripped
  const acq = one.links.find((l) => l.rel === 'http://opds-spec.org/acquisition');
  assert.equal(acq.href, '/api/opds/issue/101/file');
  assert.equal(acq.type, 'application/vnd.comicbook+zip');
  assert.equal(acq.properties.size, 5000);
  assert.equal(one.images[0].href, 'https://img/i101.jpg'); // CV cover without the reader

  // with streaming, covers come from the page pipeline
  const streamed = seriesIssuesDoc(db, 1, { streaming: true });
  const s1 = streamed.publications.find((p) => p.metadata.identifier === 'backissue:issue:101');
  assert.match(s1.images[0].href, /\/api\/opds\/issue\/101\/page\/0\?width=800/);

  assert.equal(seriesIssuesDoc(db, 99), null, 'unknown series → null → 404');
});

test('shelf docs reuse the shared queries (recent, read-later ordering)', () => {
  const db = seededDb();
  const recent = issuesDoc(recentIssues(db), { title: 'Recently added', self: '/api/opds/v2/recent' });
  assert.equal(recent.metadata.title, 'Recently added');
  // newest mtime first: Batman(201), Crossed(301), Saga#2(102), Saga#1(101)
  assert.deepEqual(recent.publications.map((p) => p.metadata.identifier),
    ['backissue:issue:201', 'backissue:issue:301', 'backissue:issue:102', 'backissue:issue:101']);
  // issuesByIds preserves given order
  const later = issuesDoc(issuesByIds(db, [102, 201]), { title: 'Read later', self: '/api/opds/v2/later' });
  assert.deepEqual(later.publications.map((p) => p.metadata.identifier),
    ['backissue:issue:102', 'backissue:issue:201']);
});

test('publishers doc: navigation entries with counts', () => {
  const db = seededDb();
  const doc = publishersDoc(db);
  assert.deepEqual(doc.navigation.map((n) => n.title), ['Avatar (1)', 'DC (1)', 'Image (1)']);
  assert.ok(doc.navigation.every((n) => n.rel === 'subsection' && n.type === OPDS2));
});
