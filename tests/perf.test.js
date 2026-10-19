// The catalog's cheaper query paths must answer exactly what the plain SQL
// did: the series snapshot (count, page, LIKE search, publisher facets), the
// newest-files walk for Recently added, and the two-step book pages. Also the
// one-minute memo (and that clearMemo drops it) and the paged author list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  seriesRows, seriesCount, publishers, recentIssues, seriesNavFeed, memo, clearMemo,
} from '../feeds.js';
import {
  bookRows, bookCount, hasBooks, multipleBookLibraries, bookAuthorsNavFeed, recentBooksFeed, RECENT_ORDER,
} from '../feeds-books.js';
import { bookAuthorsDoc } from '../feeds2.js';

function comics() {
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
  `);
  const s = db.prepare('INSERT INTO series VALUES (?, ?, ?, NULL, ?, ?)');
  const cs = db.prepare('INSERT INTO cv_series VALUES (?, ?, NULL, NULL, ?)');
  const ci = db.prepare('INSERT INTO cv_issues VALUES (?, ?, ?, NULL, NULL, NULL, NULL)');
  const lf = db.prepare('INSERT INTO library_files VALUES (?, ?, ?, ?, ?, 10, ?, 1)');
  const titles = ['batman', 'Batman Beyond', 'BATGIRL', 'Saga', 'saga deluxe', 'X-Men', 'x_factor', '100% Wolverine', 'Émile', 'émile two', 'Zot!'];
  titles.forEach((t, n) => {
    const id = n + 1;
    const cv = n % 3 ? 1000 + id : null;               // some unmatched to CV: title from series
    s.run(id, t, cv, n % 4 ? `Pub${n % 3}` : null, n === 4 ? 1 : 0);
    if (cv) cs.run(cv, n % 2 ? t : null, n % 2 ? `CvPub${n % 2}` : null);
    for (let k = 0; k < 3; k++) {
      const iss = id * 100 + k;
      ci.run(iss, cv, String(k + 1));
      lf.run(`/c/${id}-${k}.cbz`, id, iss, 1, k === 1 ? 1 : 0, 1_000_000 + id * 10 + k);
      if (k === 0) lf.run(`/c/${id}-${k}-dup.cbz`, id, iss, 1, 0, 2_000_000 + id); // a newer copy
    }
  });
  db.exec(`INSERT INTO library_files VALUES ('/c/bad.cbz', 1, 101, 0, 0, 1, 9999999, 1);
           INSERT INTO library_files VALUES ('/c/unmatched.cbz', 2, NULL, 1, 0, 1, 9999998, 1);
           INSERT INTO series VALUES (99, 'No Files', NULL, NULL, 'Pub0', 0);`);
  return db;
}

// The SQL the snapshot replaced, kept here as the reference answer.
function reference(db, { includeRestricted = true, search = '', publisher = '' } = {}) {
  const conds = []; const params = [];
  if (!includeRestricted) conds.push('s.restricted = 0');
  if (search) { conds.push('COALESCE(cv.name, s.title) LIKE ?'); params.push('%' + search + '%'); }
  if (publisher) { conds.push('COALESCE(cv.publisher, s.publisher) = ?'); params.push(publisher); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.prepare(`
    SELECT s.id, COALESCE(cv.name, s.title) AS title, cv.start_year,
           COALESCE(cv.image_url, s.cover_url) AS cover, COUNT(DISTINCT lf.cv_issue_id) AS issues
      FROM series s
      JOIN library_files lf ON lf.series_id = s.id AND lf.valid = 1 AND lf.cv_issue_id IS NOT NULL
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     ${where} GROUP BY s.id ORDER BY title COLLATE NOCASE, s.id`).all(...params);
}

test('series snapshot answers like the SQL it replaced (search, publisher, restricted, paging)', () => {
  const db = comics();
  const cases = [{}, { includeRestricted: false }, { search: 'bat' }, { search: 'BAT' }, { search: 'saga' },
    { search: '%' }, { search: 'x_' }, { search: '100%' }, { search: 'émile' }, { search: 'É' },
    { publisher: 'Pub1' }, { publisher: 'CvPub1', includeRestricted: false }, { search: 'zzz' }];
  for (const c of cases) {
    const ref = reference(db, c);
    assert.deepEqual(seriesRows(db, { ...c, limit: 100 }).map((r) => ({ ...r })), ref, JSON.stringify(c));
    assert.equal(seriesCount(db, c), ref.length, JSON.stringify(c));
  }
  assert.deepEqual(seriesRows(db, { limit: 3, offset: 3 }).map((r) => r.id), reference(db).slice(3, 6).map((r) => r.id));
  const pubs = db.prepare(`SELECT COALESCE(cv.publisher, s.publisher) AS publisher, COUNT(DISTINCT s.id) AS count
      FROM series s JOIN library_files lf ON lf.series_id = s.id AND lf.valid = 1 AND lf.cv_issue_id IS NOT NULL
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     WHERE COALESCE(cv.publisher, s.publisher) IS NOT NULL AND COALESCE(cv.publisher, s.publisher) <> ''
     GROUP BY 1 ORDER BY 1 COLLATE NOCASE`).all();
  assert.deepEqual(publishers(db).map((p) => ({ ...p })), pubs);
});

test('the snapshot is memoized per handle until it expires or is cleared', () => {
  const db = comics();
  const before = seriesCount(db);
  db.exec(`INSERT INTO series VALUES (50, 'Fresh', NULL, NULL, NULL, 0);
           INSERT INTO library_files VALUES ('/c/fresh.cbz', 50, 5000, 1, 0, 1, 1, 1);`);
  assert.equal(seriesCount(db), before, 'served from the memo');
  clearMemo(db);
  assert.equal(seriesCount(db), before + 1);
  assert.ok(seriesNavFeed(db).includes('Fresh'));
  let calls = 0;
  memo(db, 'k', () => ++calls, 0);
  memo(db, 'k', () => ++calls, 0);
  assert.equal(calls, 2, 'an expired entry is rebuilt');
});

test('recently added: newest copy first, one entry per issue, restricted skipped, page fills', () => {
  const db = comics();
  const all = recentIssues(db, { limit: 100 });
  const ids = all.map((r) => r.cv_issue_id);
  assert.equal(new Set(ids).size, ids.length, 'deduped');
  // Issues with a newer duplicate copy (k=0) come first, newest series first.
  assert.deepEqual(ids.slice(0, 3), [1100, 1000, 900]);
  assert.ok(all.every((r) => r.path), 'enriched with the best file');
  // Series 5 is restricted: its issues vanish and the page still fills.
  const open = recentIssues(db, { includeRestricted: false, limit: 12 });
  assert.equal(open.length, 12);
  assert.ok(open.every((r) => r.series_id !== 5));
  // Same set as the old GROUP BY over every file.
  const old = db.prepare(`SELECT DISTINCT lf.cv_issue_id AS id FROM library_files lf JOIN series s ON s.id = lf.series_id
     WHERE lf.valid = 1 AND lf.cv_issue_id IS NOT NULL`).all().map((r) => r.id).sort();
  assert.deepEqual([...ids].sort(), old);
});

function books(n = 130) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT, url TEXT, publisher TEXT, year TEXT,
      cover_url TEXT, description TEXT, type TEXT DEFAULT 'comic', library_id INTEGER, restricted INTEGER DEFAULT 0);
    CREATE TABLE issues (id INTEGER PRIMARY KEY, series_id INTEGER, title TEXT, issue_number TEXT,
      url TEXT, status TEXT, file_path TEXT);
    CREATE TABLE libraries (id INTEGER PRIMARY KEY, name TEXT, type TEXT, restricted INTEGER DEFAULT 0);
    CREATE TABLE ebooks_files (path TEXT, library_id INTEGER, series_id INTEGER, issue_id INTEGER,
      format TEXT, size INTEGER, isbn TEXT, language TEXT, source TEXT, remote_id TEXT, added_at TEXT);
    INSERT INTO libraries VALUES (1,'Fiction','ebook',0),(2,'Other','ebook',0);
  `);
  const s = db.prepare("INSERT INTO series VALUES (?, ?, ?, ?, '2000', NULL, NULL, 'ebook', 1, ?)");
  const i = db.prepare("INSERT INTO issues VALUES (?, ?, ?, '1', ?, 'done', NULL)");
  const f = db.prepare("INSERT INTO ebooks_files VALUES (NULL, 1, ?, ?, 'epub', 1, NULL, NULL, 'x', ?, ?)");
  for (let k = 1; k <= n; k++) {
    s.run(k, `Book ${k % 7}`, `u${k}`, `Author ${k % 60}`, k % 10 === 0 ? 1 : 0);
    i.run(k * 10, k, `Book ${k % 7}`, `i${k}`);              // many titles tie
    f.run(k, k * 10, `r${k}`, `2026-01-${String(1 + (k % 28)).padStart(2, '0')}T00:00:00Z`);
  }
  return db;
}

test('book pages: the two-step page equals the one-step query, ties page without repeats', () => {
  const db = books();
  const oneStep = db.prepare(`SELECT i.id FROM series s JOIN issues i ON i.series_id = s.id
      JOIN ebooks_files ef ON ef.issue_id = i.id WHERE s.type = 'ebook' AND s.restricted = 0
      ORDER BY i.title COLLATE NOCASE, ef.rowid`).all().map((r) => r.id);
  const paged = [];
  for (let p = 0; p * 50 < oneStep.length; p++) {
    paged.push(...bookRows(db, { includeRestricted: false, limit: 50, offset: p * 50 }).map((r) => r.issue_id));
  }
  assert.deepEqual(paged, oneStep);
  assert.equal(bookCount(db, { includeRestricted: false }), oneStep.length);
  assert.equal(bookCount(db), 130);
  const full = bookRows(db, { limit: 1 })[0];
  assert.equal(typeof full.series_count, 'number');
  assert.ok(!('_rid' in full));
});

test('recent books walk added_at newest first and honour restriction', () => {
  const db = books();
  const ref = db.prepare(`SELECT i.id FROM series s JOIN issues i ON i.series_id = s.id
      JOIN ebooks_files ef ON ef.issue_id = i.id WHERE s.type = 'ebook' AND s.restricted = 0
      ORDER BY ef.added_at DESC, i.id DESC LIMIT 50`).all().map((r) => r.id);
  const got = bookRows(db, { includeRestricted: false, order: RECENT_ORDER, limit: 50 }).map((r) => r.issue_id);
  assert.deepEqual(got, ref);
  assert.ok(recentBooksFeed(db, {}).includes('opds:book:'));
});

test('book visibility probes and the paged author list', () => {
  const db = books();
  assert.equal(hasBooks(db), true);
  assert.equal(multipleBookLibraries(db), false);
  db.exec("UPDATE series SET library_id = 2 WHERE id = 3");
  assert.equal(multipleBookLibraries(db), true);
  db.exec("UPDATE series SET restricted = 1");
  assert.equal(hasBooks(db, { includeRestricted: false }), false);
  assert.equal(hasBooks(db), true);

  const db2 = books();
  const p1 = bookAuthorsNavFeed(db2, { page: 1 });
  assert.equal((p1.match(/<entry>/g) || []).length, 50);
  assert.match(p1, /rel="next" href="\/api\/opds\/books\/authors\?page=2"/);
  const p2 = bookAuthorsNavFeed(db2, { page: 2 });
  assert.equal((p2.match(/<entry>/g) || []).length, 10, '60 authors → 50 + 10');
  const doc = bookAuthorsDoc(db2, { page: 2 });
  assert.equal(doc.navigation.length, 10);
  assert.equal(doc.metadata.numberOfItems, 60);
});
