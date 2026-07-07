// OPDS feed builders against a seeded catalog: series/issue selection rules
// (valid + CV-matched files only, best copy per issue), XML escaping, PSE
// links gated on the streaming flag and page counts, plus search, pagination,
// publisher browse/facets, recently-added, the reader shelves, restricted
// filtering, and richer acquisition entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  rootFeed, opensearchDoc, seriesNavFeed, publishersNavFeed, seriesAcqFeed, issuesAcqFeed,
  seriesRows, seriesCount, publishers, recentIssues, issuesByIds,
  readerContinue, readerLater, hasReaderTables, downloadName,
  bestFile, fileType, esc,
} from '../feeds.js';

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

    INSERT INTO series (id,title,cv_id,cover_url,publisher,restricted) VALUES (1,'Saga & Friends',900,NULL,'Image',0);
    INSERT INTO series (id,title,cv_id,cover_url,publisher,restricted) VALUES (2,'Empty',NULL,NULL,NULL,0);
    INSERT INTO series (id,title,cv_id,cover_url,publisher,restricted) VALUES (3,'Batman',700,NULL,'DC',0);
    INSERT INTO series (id,title,cv_id,cover_url,publisher,restricted) VALUES (4,'Crossed',800,NULL,'Avatar',1);

    INSERT INTO cv_series VALUES (900,'Saga & Friends','2012','https://img/900.jpg','Image');
    INSERT INTO cv_series VALUES (700,'Batman','2016',NULL,'DC');
    INSERT INTO cv_series VALUES (800,'Crossed','2008',NULL,'Avatar');

    INSERT INTO cv_issues VALUES (101,900,'1','Chapter <One>','2012-03-01','<p>The <b>first</b> issue.</p>','https://img/i101.jpg');
    INSERT INTO cv_issues VALUES (102,900,'10','Chapter Ten','2013-01-01',NULL,NULL);
    INSERT INTO cv_issues VALUES (103,900,'2',NULL,'2012-04-01',NULL,NULL);
    INSERT INTO cv_issues VALUES (201,700,'1','Year One','2016-06-01',NULL,NULL);
    INSERT INTO cv_issues VALUES (301,800,'1','Patient Zero','2008-01-01',NULL,NULL);

    -- two copies of #1: the tagged one must win. Sizes + mtimes set for tests.
    INSERT INTO library_files VALUES ('/lib/saga1-untagged.cbz', 1, 101, 1, 0, 22, 1700000000000, 100);
    INSERT INTO library_files VALUES ('/lib/saga1.cbz',          1, 101, 1, 1, 22, 1700000000000, 5000);
    INSERT INTO library_files VALUES ('/lib/saga10.cbr',         1, 102, 1, 1, 30, 1700000500000, 6000);
    INSERT INTO library_files VALUES ('/lib/saga2.pdf',          1, 103, 1, 1, NULL, 1700000200000, 7000);
    INSERT INTO library_files VALUES ('/lib/batman1.cbz',        3, 201, 1, 1, 40, 1800000000000, 8000);
    INSERT INTO library_files VALUES ('/lib/crossed1.cbz',       4, 301, 1, 1, 25, 1750000000000, 9000);
    -- corrupt + unmatched files never appear
    INSERT INTO library_files VALUES ('/lib/broken.cbz',   1, 101, 0, 0, NULL, NULL, 1);
    INSERT INTO library_files VALUES ('/lib/mystery.cbz',  1, NULL, 1, 0, 12, NULL, 1);
  `);
  return db;
}

// A seed with the reader plugin's tables present.
function seededWithReader() {
  const db = seededDb();
  db.exec(`
    CREATE TABLE reader_progress (user_id INTEGER, issue_id INTEGER, page INTEGER, pages INTEGER,
      completed INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE reader_later (user_id INTEGER, issue_id INTEGER, added_at TEXT);
    -- user 0: mid-way through Saga #1 (recent), finished Batman #1 (excluded)
    INSERT INTO reader_progress VALUES (0, 101, 5, 22, 0, '2024-01-02T00:00:00Z');
    INSERT INTO reader_progress VALUES (0, 201, 40, 40, 1, '2024-01-01T00:00:00Z');
    -- read-later: Saga #10 then Batman #1
    INSERT INTO reader_later VALUES (0, 102, '2024-02-02T00:00:00Z');
    INSERT INTO reader_later VALUES (0, 201, '2024-02-01T00:00:00Z');
  `);
  return db;
}

test('nav feeds: root shelves + search link; series list counts distinct readable issues', () => {
  const db = seededDb();
  const root = rootFeed({ hasReader: false });
  assert.match(root, /href="\/api\/opds\/series"/);
  assert.match(root, /href="\/api\/opds\/recent"/);
  assert.match(root, /href="\/api\/opds\/publishers"/);
  assert.match(root, /rel="search"/, 'advertises the OpenSearch descriptor');
  assert.ok(!root.includes('/api/opds/continue'), 'reading shelves hidden without the reader plugin');
  // with the reader present, the reading shelves appear
  assert.match(rootFeed({ hasReader: true }), /href="\/api\/opds\/continue"/);

  const nav = seriesNavFeed(db);
  assert.match(nav, /Saga &amp; Friends \(2012\)/);
  assert.match(nav, /3 issues on the shelf/, 'two copies of #1 count once');
  assert.match(nav, /href="https:\/\/img\/900.jpg"/);
  assert.ok(!nav.includes('>Empty<'), 'series without files are hidden');
});

test('acquisition feed: natural order, escaping, best-file types, size, summary, PSE gating', () => {
  const db = seededDb();
  const feed = seriesAcqFeed(db, 1, { streaming: true });
  // natural issue order: 1, 2, 10 (not lexicographic 1, 10, 2)
  const order = [...feed.matchAll(/backissue:opds:issue:(\d+)/g)].map((m) => m[1]);
  assert.deepEqual(order, ['101', '103', '102']);
  assert.match(feed, /#1 — Chapter &lt;One&gt;/);
  assert.match(feed, /issue\/101\/file" type="application\/vnd\.comicbook\+zip" length="5000"/, 'tagged copy + its size');
  assert.match(feed, /issue\/102\/file" type="application\/vnd\.comicbook-rar"/);
  assert.match(feed, /issue\/103\/file" type="application\/pdf"/);
  // description is flattened to a tag-free summary
  assert.match(feed, /<summary type="text">The first issue\.<\/summary>/);
  assert.match(feed, /<category term="Image"/);
  // PSE: present with a page count, absent without one (the PDF), templated
  assert.match(feed, /issue\/101\/page\/\{pageNumber\}\?width=\{maxWidth\}" pse:count="22"/);
  assert.ok(!feed.includes('issue/103/page/{pageNumber}'), 'no PSE link without a page count');

  // without streaming (reader absent): downloads + CV cover, no page routes
  const plain = seriesAcqFeed(db, 1, { streaming: false });
  assert.ok(!plain.includes('/page/'), 'no page routes without the reader pipeline');
  assert.match(plain, /issue\/101\/file/);
  assert.match(plain, /thumbnail" href="https:\/\/img\/i101.jpg"/, 'falls back to the CV cover');

  assert.equal(seriesAcqFeed(db, 99), null, 'unknown series → null → 404');
});

test('search + pagination: filter by title, honour limit/offset, report totals', () => {
  const db = seededDb();
  // search matches on the CV/series title
  const hit = seriesNavFeed(db, { search: 'saga' });
  assert.match(hit, /Saga &amp; Friends/);
  assert.ok(!hit.includes('>Batman<'));
  assert.match(hit, /<opensearch:totalResults>1<\/opensearch:totalResults>/);
  // a miss still yields a valid, empty feed
  const miss = seriesNavFeed(db, { search: 'zzzzz' });
  assert.match(miss, /<opensearch:totalResults>0<\/opensearch:totalResults>/);
  assert.ok(!miss.includes('backissue:opds:series:'));

  // raw paging mechanics on seriesRows (3 series have files: 1, 3, 4)
  assert.equal(seriesCount(db), 3);
  assert.equal(seriesRows(db, { limit: 2, offset: 0 }).length, 2);
  assert.equal(seriesRows(db, { limit: 2, offset: 2 }).length, 1);
  // ordered alphabetically: Batman, Crossed, Saga & Friends
  assert.deepEqual(seriesRows(db).map((r) => r.title), ['Batman', 'Crossed', 'Saga & Friends']);
});

test('publishers: browse feed, distinct counts, and inline facets on the series list', () => {
  const db = seededDb();
  const pubs = publishers(db);
  assert.deepEqual(pubs.map((p) => p.publisher), ['Avatar', 'DC', 'Image']);
  assert.match(publishersNavFeed(db), /<title>DC<\/title>/);
  // series list carries a facet link per publisher
  const nav = seriesNavFeed(db);
  assert.match(nav, /rel="http:\/\/opds-spec\.org\/facet" href="\/api\/opds\/publisher\/DC" title="DC \(1\)" opds:facetGroup="Publisher"/);
  // filtering to one publisher marks the active facet
  const dc = seriesNavFeed(db, { publisher: 'DC' });
  assert.match(dc, /publisher\/DC" title="DC \(1\)" opds:facetGroup="Publisher" opds:activeFacet="true"/);
  assert.match(dc, />Batman \(2016\)</);
  assert.ok(!dc.includes('Saga'));
});

test('recently added: issues ordered by mtime, richest first; restricted excluded on request', () => {
  const db = seededDb();
  const all = recentIssues(db).map((r) => r.cv_issue_id);
  assert.deepEqual(all, [201, 301, 102, 103, 101], 'newest mtime first');
  // a role without the mature permission never sees the Crossed issue
  const safe = recentIssues(db, { includeRestricted: false }).map((r) => r.cv_issue_id);
  assert.ok(!safe.includes(301));
  const feed = issuesAcqFeed(recentIssues(db), { id: 'opds:recent', title: 'Recently added', self: '/api/opds/recent', streaming: false });
  assert.match(feed, /<title>Recently added<\/title>/);
  assert.match(feed, /backissue:opds:issue:201/);
});

test('reader shelves: continue (unfinished, recent-first) and read-later, order preserved', () => {
  const db = seededWithReader();
  assert.equal(hasReaderTables(db), true);
  // continue: Saga #1 in progress; Batman #1 is finished → excluded
  const cont = readerContinue(db, 0);
  assert.deepEqual(cont, [101]);
  // read-later keeps insertion (added_at desc) order: #102 then #201
  const later = readerLater(db, 0);
  assert.deepEqual(later, [102, 201]);
  // issuesByIds returns enriched rows IN the given order
  const rows = issuesByIds(db, later);
  assert.deepEqual(rows.map((r) => r.cv_issue_id), [102, 201]);
  assert.equal(rows[0].series_title, 'Saga & Friends');
});

test('reader shelves degrade gracefully when the reader plugin is absent', () => {
  const db = seededDb(); // no reader_* tables
  assert.equal(hasReaderTables(db), false);
  assert.deepEqual(readerContinue(db, 0), []);
  assert.deepEqual(readerLater(db, 0), []);
});

test('restricted filtering: mature series hidden from series list and shelves', () => {
  const db = seededDb(); // Crossed (series 4 / issue 301) is restricted
  assert.deepEqual(seriesRows(db, { includeRestricted: false }).map((r) => r.title), ['Batman', 'Saga & Friends']);
  assert.equal(seriesCount(db, { includeRestricted: false }), 2);
  // issuesByIds honours the flag too (shelf enforcement)
  const rows = issuesByIds(db, [301, 101], { includeRestricted: false });
  assert.deepEqual(rows.map((r) => r.cv_issue_id), [101]);
});

test('helpers: bestFile, fileType, esc, downloadName, opensearchDoc', () => {
  const db = seededDb();
  assert.equal(bestFile(db, 101).path, '/lib/saga1.cbz');
  assert.equal(bestFile(db, 101).size, 5000);
  assert.equal(bestFile(db, 999), null);
  assert.equal(fileType('x.CBZ'), 'application/vnd.comicbook+zip');
  assert.equal(fileType('weird.txt'), 'application/octet-stream');
  assert.equal(esc(`<&"'>`), '&lt;&amp;&quot;&apos;&gt;');
  // a human filename from catalog metadata
  assert.equal(downloadName(db, 101, '/lib/saga1.cbz'), 'Saga & Friends - #1.cbz');
  assert.match(opensearchDoc(), /template="\/api\/opds\/search\?q=\{searchTerms\}"/);
});
