'use strict';

// macOS system notifications, read from Notification Center's own database (needs Full Disk Access).
// Nothing is stored or sent anywhere: new rows are handed to the overlay, which shows app and title.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const plist = require('plist');

const DB = path.join(os.homedir(), 'Library/Group Containers/group.com.apple.usernoted/db2/db');
const POLL_MS = 2000;
const OWN = /^(capri|com\.github\.electron|com\.todesktop)/i;

// the record's blob is a binary plist; plutil turns it into XML for the plist package
function decode(blob) {
  return new Promise((resolve) => {
    const child = execFile('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { timeout: 3000, maxBuffer: 1 << 20 },
      (err, out) => {
        if (err) return resolve(null);
        try { resolve(plist.parse(out)); } catch { resolve(null); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(blob);
  });
}

function startNotificationWatch({ onNotification, onState }) {
  if (process.platform !== 'darwin') return { stop() {} };

  let db = null;
  let lastId = null;
  let timer = null;
  let state = null;

  const setState = (next) => {
    if (next !== state) { state = next; onState?.(next); }
  };

  function open() {
    if (db) return true;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(DB, { readOnly: true });
      setState('ok');
      return true;
    } catch (err) {
      // EPERM / "operation not permitted": Full Disk Access isn't granted to Capri
      db = null;
      setState(fs.existsSync(DB) || /perm/i.test(err.message) ? 'denied' : 'missing');
      return false;
    }
  }

  async function poll() {
    try {
      if (!open()) return;
      if (lastId === null) {
        lastId = db.prepare('SELECT COALESCE(MAX(rec_id), 0) AS id FROM record').get().id; // only what arrives from now on
        return;
      }
      const rows = db.prepare(
        'SELECT rec.rec_id AS id, a.identifier AS app, rec.data AS data FROM record rec JOIN app a USING(app_id) WHERE rec.rec_id > ? ORDER BY rec.rec_id',
      ).all(lastId);
      for (const row of rows) {
        lastId = Math.max(lastId, row.id);
        if (OWN.test(row.app)) continue;
        const data = await decode(row.data);
        const req = data?.req || {};
        onNotification({ app: row.app, title: String(req.titl || ''), body: String(req.body || ''), subtitle: String(req.subt || '') });
      }
    } catch {
      try { db?.close(); } catch { /* already closed */ }
      db = null; // reopened on the next tick: the database gets swapped when macOS rewrites it
    }
  }

  timer = setInterval(poll, POLL_MS);
  poll();
  return {
    stop() {
      clearInterval(timer);
      try { db?.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { startNotificationWatch };
