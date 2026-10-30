'use strict';

// WhatsApp and Discord notifications (Windows only). Windows keeps every toast it shows in a small
// SQLite database; we poll a copy of it and pass on the new ones from those two apps (the desktop
// apps, and Phone Link mirroring your phone's), and nothing from any other app: the handler is
// matched before the payload is ever read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 3000;
const DIR = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications');
const SOURCES = [
  [/whatsapp/i, 'WhatsApp'],
  [/discord/i, 'Discord'],
];

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch { /* no sqlite in this runtime: no notifications */ }

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

// the <text> lines of a toast's XML: the first is usually who, the next what they said
function toastLines(payload) {
  const xml = Buffer.from(payload).toString(payload[0] === 0xff ? 'utf16le' : 'utf8');
  return [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decode(m[1]).trim()).filter(Boolean);
}

function startNotificationWatch({ onNotification }) {
  if (process.platform !== 'win32' || !DatabaseSync) return { stop() {} };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-wpn-'));
  let seen = null; // the newest notification Id already handled (BigInt)
  let timer = null;
  let busy = false;

  // a copy, with its journal: the live file is held open by Windows
  function snapshot() {
    for (const name of ['wpndatabase.db', 'wpndatabase.db-wal', 'wpndatabase.db-shm']) {
      const from = path.join(DIR, name);
      const to = path.join(tmp, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
      else fs.rmSync(to, { force: true });
    }
    return path.join(tmp, 'wpndatabase.db');
  }

  function poll() {
    if (busy) return;
    busy = true;
    let db = null;
    try {
      db = new DatabaseSync(snapshot(), { readOnly: true });
      const all = (sql, ...args) => {
        const st = db.prepare(sql);
        st.setReadBigInts(true);
        return st.all(...args);
      };
      const top = all('SELECT MAX(Id) AS id FROM Notification')[0]?.id ?? 0n;
      if (seen === null) { // the first look: what's already there isn't news
        seen = top;
        return;
      }
      if (top <= seen) return;
      const rows = all(
        `SELECT n.Id AS id, n.Payload AS payload, h.PrimaryId AS handler
           FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
          WHERE n.Id > ? AND n.Type = 'toast' ORDER BY n.Id`,
        seen,
      );
      seen = top;
      for (const row of rows) {
        const source = SOURCES.find(([re]) => re.test(String(row.handler)));
        if (!source || !row.payload) continue;
        const [title = '', ...rest] = toastLines(row.payload);
        onNotification({ app: source[1], title, text: rest.join(' ') });
      }
    } catch (err) {
      console.error('[capri] notifications:', err.message);
    } finally {
      db?.close();
      busy = false;
    }
  }

  timer = setInterval(poll, POLL_MS);
  poll();
  return {
    stop() {
      clearInterval(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

module.exports = { startNotificationWatch };
