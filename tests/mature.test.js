// The catalog keeps mature series from roles without the permission and from
// accounts that switched mature content off for themselves (OPDS apps sign in
// with the same accounts as the web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the series feed hides mature series by role and by the account switch', async () => {
  process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
  process.env.METADATA_BASE_OVERRIDE = 'http://127.0.0.1:9/api';
  const { openDb } = await import('../../../src/db.js');
  const { initUserTables } = await import('../../../src/users.js');
  const { pluginApi, registeredRoutes } = await import('../../../src/plugins.js');
  const config = (await import('../../../src/config.js')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opds-mature-'));
  config.dbPath = path.join(dir, 'cat.db');
  const db = openDb(config.dbPath);
  initUserTables(db); // built-in roles, as the server does at boot
  for (const [sid, iid, title, restricted] of [[10, 100, 'Plain Tales', 0], [20, 200, 'Mature Tales', 1]]) {
    db.prepare('INSERT INTO cv_series (comicvine_id, name) VALUES (?, ?)').run(sid, title);
    db.prepare('INSERT INTO cv_issues (comicvine_id, cv_series_id, name, issue_number) VALUES (?, ?, ?, 1)').run(iid, sid, title);
    const series = db.prepare('INSERT INTO series (title, url, cv_id, restricted) VALUES (?, ?, ?, ?)').run(title, 'u:' + title, sid, restricted).lastInsertRowid;
    db.prepare('INSERT INTO library_files (path, series_id, cv_issue_id, valid) VALUES (?, ?, ?, 1)').run(path.join(dir, title + '.cbz'), series, iid);
  }
  await (await import('../index.js')).default(pluginApi);
  const handler = registeredRoutes().find((r) => r.method === 'get' && r.path === '/api/opds/series').handler;
  const feed = (user) => new Promise((resolve) => {
    const res = { set() { return this; }, type() { return this; }, status() { return this; }, send: (b) => resolve(String(b)), end: () => resolve('') };
    handler({ user, query: {}, params: {}, headers: {}, protocol: 'http', get: () => 'localhost' }, res);
  });

  const all = await feed({ id: 1, role: 'admin', hide_mature: 0 });
  assert.match(all, /Mature Tales/);
  assert.match(all, /Plain Tales/);
  const optedOut = await feed({ id: 2, role: 'admin', hide_mature: 1 });
  assert.doesNotMatch(optedOut, /Mature Tales/, 'the account switch hides it');
  assert.match(optedOut, /Plain Tales/);
  assert.doesNotMatch(await feed({ id: 3, role: 'viewer', hide_mature: 0 }), /Mature Tales/, 'so does a role without the permission');
});
