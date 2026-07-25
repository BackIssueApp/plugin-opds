// Ebook (EPUB/PDF) OPDS branch: book selection over series.type='ebook' joined
// to the ebooks plugin's ebooks_files table (NOT the comic library_files join),
// so file-less on-demand books are included; MIME per format; nav layout; the
// download link target (/api/ebooks/issue/:id/file); restricted gating; and the
// soft dependency — a catalog without ebooks_files yields no books, no crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rootFeed } from '../feeds.js';
import {
  hasEbookTables, bookCount, bookAuthors, bookSeries, ebookLibrariesList,
  booksRootNavFeed, allBooksFeed, recentBooksFeed, bookAuthorsNavFeed,
  booksByAuthorFeed, bookSeriesNavFeed, booksBySeriesFeed, bookLibrariesNavFeed,
  booksByLibraryFeed, booksSearchFeed, bookMime, booksOpensearchDoc,
} from '../feeds-books.js';
import { rootDoc, allBooksDoc, booksBySeriesDoc, bookAuthorsDoc } from '../feeds2.js';

// A catalog with the core tables the ebook branch needs (series/issues/
// libraries) plus the ebooks plugin's ebooks_files table.
function seededBooks() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT, url TEXT, publisher TEXT, year TEXT,
      cover_url TEXT, description TEXT, type TEXT DEFAULT 'comic', library_id INTEGER, restricted INTEGER DEFAULT 0);
    CREATE TABLE issues (id INTEGER PRIMARY KEY, series_id INTEGER, title TEXT, issue_number TEXT,
      url TEXT, status TEXT, file_path TEXT);
    CREATE TABLE libraries (id INTEGER PRIMARY KEY, name TEXT, type TEXT, restricted INTEGER DEFAULT 0);
    CREATE TABLE ebooks_files (path TEXT, library_id INTEGER, series_id INTEGER, issue_id INTEGER,
      format TEXT, size INTEGER, isbn TEXT, language TEXT, source TEXT, remote_id TEXT, added_at TEXT);

    INSERT INTO libraries VALUES (1,'Fiction','ebook',0),(2,'Reference','ebook',0),(3,'Adult','ebook',1);

    -- A standalone book (single-issue self-described series) with a local EPUB.
    INSERT INTO series VALUES (10,'Dune','ebook:l1:b:dune~herbert','Frank Herbert','1965',NULL,
      '<p>A <b>desert</b> epic.</p>','ebook',1,0);
    INSERT INTO issues VALUES (100,10,'Dune','1','ebookfile:/lib/dune.epub','done','/lib/dune.epub');
    INSERT INTO ebooks_files VALUES ('/lib/dune.epub',1,10,100,'epub',500000,'9780441172719','en',NULL,NULL,'2026-01-01T00:00:00Z');

    -- A calibre multi-book series: two PDFs, one FILE-LESS on-demand (path NULL,
    -- source set) — it must still list with a working acquisition link.
    INSERT INTO series VALUES (11,'Foundation','ebook:l1:s:foundation','Isaac Asimov','1951',NULL,NULL,'ebook',1,0);
    INSERT INTO issues VALUES (110,11,'Foundation','1','ebookfile:/lib/f1.pdf','done','/lib/f1.pdf');
    INSERT INTO issues VALUES (111,11,'Second Foundation','2','ebookremote:bw:xyz','done',NULL);
    INSERT INTO ebooks_files VALUES ('/lib/f1.pdf',1,11,110,'pdf',700000,NULL,'en',NULL,NULL,'2026-02-01T00:00:00Z');
    INSERT INTO ebooks_files VALUES (NULL,1,11,111,'pdf',NULL,NULL,NULL,'bw','xyz','2026-03-01T00:00:00Z');

    -- A book in a second library (so per-library browse has >1 library).
    INSERT INTO series VALUES (12,'SICP','ebook:l2:b:sicp~abelson','Abelson, Sussman','1985',NULL,NULL,'ebook',2,0);
    INSERT INTO issues VALUES (120,12,'SICP','1','ebookfile:/lib/sicp.epub','done','/lib/sicp.epub');
    INSERT INTO ebooks_files VALUES ('/lib/sicp.epub',2,12,120,'epub',900000,NULL,'en',NULL,NULL,'2026-02-15T00:00:00Z');

    -- A restricted book (library 3) — hidden from readers without permission.
    INSERT INTO series VALUES (13,'Forbidden','ebook:l3:b:forbidden~x','X','2000',NULL,NULL,'ebook',3,1);
    INSERT INTO issues VALUES (130,13,'Forbidden','1','ebookfile:/lib/forbidden.epub','done','/lib/forbidden.epub');
    INSERT INTO ebooks_files VALUES ('/lib/forbidden.epub',3,13,130,'epub',100,NULL,NULL,NULL,NULL,'2026-04-01T00:00:00Z');

    -- A comic series must never appear in the book branch.
    INSERT INTO series VALUES (20,'Saga','cv:900','Image','2012',NULL,NULL,'comic',NULL,0);
    INSERT INTO issues VALUES (200,20,'Saga #1','1','cv:i101','done','/lib/saga1.cbz');
  `);
  return db;
}

test('hasEbookTables + MIME + counts, restricted honoured', () => {
  const db = seededBooks();
  assert.equal(hasEbookTables(db), true);
  assert.equal(bookMime('epub'), 'application/epub+zip');
  assert.equal(bookMime('PDF'), 'application/pdf');
  assert.equal(bookMime('weird'), 'application/octet-stream');
  // 5 books total (Dune, Foundation x2, SICP, Forbidden); the comic is excluded.
  assert.equal(bookCount(db), 5);
  // a viewer without library.restricted sees 4 (Forbidden hidden).
  assert.equal(bookCount(db, { includeRestricted: false }), 4);
});

test('root nav gains a Books entry only when books exist', () => {
  assert.ok(rootFeed({ hasBooks: true }).includes('href="/api/opds/books"'));
  assert.ok(!rootFeed({ hasBooks: false }).includes('/api/opds/books"'));
  assert.ok(rootDoc({ hasBooks: true }).navigation.some((n) => n.title === 'Books'));
  assert.ok(!rootDoc({ hasBooks: false }).navigation.some((n) => n.title === 'Books'));
});

test('books submenu: shelves + per-library entry when >1 ebook library', () => {
  const db = seededBooks();
  const nav = booksRootNavFeed(db);
  assert.match(nav, /href="\/api\/opds\/books\/all"/);
  assert.match(nav, /href="\/api\/opds\/books\/recent"/);
  assert.match(nav, /href="\/api\/opds\/books\/authors"/);
  assert.match(nav, /href="\/api\/opds\/books\/series"/);
  assert.match(nav, /href="\/api\/opds\/books\/libraries"/, 'two ebook libraries → Libraries entry');
  // the book head advertises the BOOK opensearch descriptor, not the comic one
  assert.match(nav, /rel="search"[^>]*href="\/api\/opds\/books\/opensearch\.xml"/);
});

test('all-books acquisition entries: title, author, mime, ISBN, download link', () => {
  const db = seededBooks();
  const feed = allBooksFeed(db);
  // standalone book: plain title, author element, EPUB mime + size, cover route
  assert.match(feed, /<title>Dune<\/title>/);
  assert.match(feed, /<author><name>Frank Herbert<\/name><\/author>/);
  assert.match(feed, /acquisition" href="\/api\/ebooks\/issue\/100\/file\?dl=1" type="application\/epub\+zip" length="500000"/);
  assert.match(feed, /image\/thumbnail" href="\/api\/ebooks\/issue\/100\/cover"/);
  assert.match(feed, /urn:isbn:9780441172719/);
  assert.match(feed, /<dcterms:language[^>]*>en<\/dcterms:language>/);
  // standalone description flattened into a summary
  assert.match(feed, /<summary type="text">A desert epic\.<\/summary>/);
  // calibre member: series + position in the title
  assert.match(feed, /<title>Foundation #1<\/title>/);
});

test('file-less on-demand book still gets an acquisition entry (no length)', () => {
  const db = seededBooks();
  const feed = allBooksFeed(db);
  // issue 111 has NULL path (remote) — its download link still resolves and
  // carries the pdf mime, with NO length attribute (size unknown until fetched).
  assert.match(feed, /backissue:opds:book:111/);
  assert.match(feed, /acquisition" href="\/api\/ebooks\/issue\/111\/file\?dl=1" type="application\/pdf"\/>/);
  assert.ok(!/issue\/111\/file[^>]*length=/.test(feed), 'no length for a file-less book');
});

test('recently added: newest ebooks_files.added_at first', () => {
  const db = seededBooks();
  const feed = recentBooksFeed(db);
  const order = [...feed.matchAll(/backissue:opds:book:(\d+)/g)].map((m) => m[1]);
  // added_at desc: 111(Mar) 120(Feb15) 110(Feb1) 100(Jan1) — Forbidden(Apr) is
  // included here (recent default includes restricted); the restricted-off path
  // is covered separately.
  assert.deepEqual(order, ['130', '111', '120', '110', '100']);
});

test('by author: nav grouped by byline, then that author\'s books', () => {
  const db = seededBooks();
  const authors = bookAuthors(db, { includeRestricted: false }).map((a) => a.author);
  assert.deepEqual(authors, ['Abelson, Sussman', 'Frank Herbert', 'Isaac Asimov']);
  const nav = bookAuthorsNavFeed(db, { includeRestricted: false });
  assert.match(nav, /href="\/api\/opds\/books\/author\/Isaac%20Asimov"/);
  const feed = booksByAuthorFeed(db, 'Isaac Asimov');
  assert.match(feed, /Foundation #1/);
  assert.match(feed, /Foundation #2/);
  assert.ok(!feed.includes('>Dune<'));
});

test('by series: only multi-book series listed, ordered by index', () => {
  const db = seededBooks();
  const list = bookSeries(db).map((s) => s.title);
  assert.deepEqual(list, ['Foundation'], 'standalone books are not a "series"');
  const feed = booksBySeriesFeed(db, 11);
  const order = [...feed.matchAll(/backissue:opds:book:(\d+)/g)].map((m) => m[1]);
  assert.deepEqual(order, ['110', '111'], 'ordered by issue_number');
  assert.equal(booksBySeriesFeed(db, 999), null, 'unknown series → null → 404');
  // a standalone series id yields the same books but is not offered under "by series"
  const nav = bookSeriesNavFeed(db);
  assert.ok(!nav.includes('Dune'));
});

test('per-library browse: entries + a library\'s books; restricted library hidden', () => {
  const db = seededBooks();
  const libs = ebookLibrariesList(db, { includeRestricted: false }).map((l) => l.name);
  assert.deepEqual(libs, ['Fiction', 'Reference'], 'restricted Adult library hidden');
  const nav = bookLibrariesNavFeed(db, { includeRestricted: false });
  assert.match(nav, /href="\/api\/opds\/books\/library\/1"/);
  const feed = booksByLibraryFeed(db, 2, { includeRestricted: false });
  assert.match(feed, /<title>SICP<\/title>/);
  assert.ok(!feed.includes('Dune'));
  // restricted library returns null for a viewer without permission → 404
  assert.equal(booksByLibraryFeed(db, 3, { includeRestricted: false }), null);
});

test('restricted gating: Forbidden hidden from list/search for viewers', () => {
  const db = seededBooks();
  const safe = allBooksFeed(db, { includeRestricted: false });
  assert.ok(!safe.includes('Forbidden'));
  assert.ok(!safe.includes('issue/130/'));
  // and it IS visible with permission
  assert.ok(allBooksFeed(db, { includeRestricted: true }).includes('Forbidden'));
});

test('book search matches title, series, or author', () => {
  const db = seededBooks();
  const hit = booksSearchFeed(db, { search: 'foundation' });
  assert.match(hit, /Foundation #1/);
  assert.ok(!hit.includes('>Dune<'));
  assert.match(booksSearchFeed(db, { search: 'herbert' }), /<title>Dune<\/title>/);
  assert.match(booksSearchFeed(db, { search: 'zzz' }), /<opensearch:totalResults>0<\/opensearch:totalResults>/);
  assert.match(booksOpensearchDoc(), /template="\/api\/opds\/books\/search\?q=\{searchTerms\}"/);
});

test('OPDS 2.0 book docs: publications + belongsTo series, author objects', () => {
  const db = seededBooks();
  const all = allBooksDoc(db);
  const dune = all.publications.find((p) => p.metadata.title === 'Dune');
  assert.equal(dune.links[0].href, '/api/ebooks/issue/100/file?dl=1');
  assert.equal(dune.links[0].type, 'application/epub+zip');
  assert.equal(dune.metadata.identifier, 'urn:isbn:9780441172719');
  assert.deepEqual(dune.metadata.author, [{ name: 'Frank Herbert' }]);
  const series = booksBySeriesDoc(db, 11);
  const f1 = series.publications.find((p) => p.metadata.title === 'Foundation #1');
  assert.equal(f1.metadata.belongsTo.series.name, 'Foundation');
  assert.ok(bookAuthorsDoc(db, { includeRestricted: false }).navigation.some((n) => n.title.startsWith('Isaac Asimov')));
});

test('soft dependency: no ebooks_files table → no books, no crash', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT, type TEXT, publisher TEXT,
    year TEXT, description TEXT, library_id INTEGER, restricted INTEGER DEFAULT 0);
    CREATE TABLE issues (id INTEGER PRIMARY KEY, series_id INTEGER, title TEXT, issue_number TEXT);`);
  assert.equal(hasEbookTables(db), false);
  assert.equal(bookCount(db), 0);
  assert.deepEqual(bookAuthors(db), []);
  assert.deepEqual(bookSeries(db), []);
  assert.deepEqual(ebookLibrariesList(db), []);
  // feeds build without throwing, just empty
  assert.match(allBooksFeed(db), /<feed[\s\S]*<\/feed>/);
  assert.equal(booksBySeriesFeed(db, 1), null);
  assert.match(booksRootNavFeed(db), /<title>Books<\/title>/);
});
