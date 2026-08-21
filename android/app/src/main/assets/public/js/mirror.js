// mirror.js
// Keeps the GPX files on disk in step with the database.
//
// Direction of truth is one-way and deliberate: IndexedDB is authoritative and
// the folders are a reflection of it. The app never reads its own data back
// from the filesystem, so a revoked permission, an unmounted card or a
// hand-edited file can leave the mirror stale but can never stop Datum
// working or lose a record. Loading a session reads the database, not a
// folder.
//
// The reverse arrangement, treating the folders as the source, would mean
// every read hits external storage and would drag in the whole two-way sync
// problem: what happens when a file is malformed mid-trip, when both sides
// changed, when the directory disappears. On a device where storage
// permission can be withdrawn at any moment, an app that cannot load its own
// data because a folder went away is a bad failure mode in the field.

import * as Store from './dataStore.js';
import * as Storage from './storage.js';
import { buildGpx } from './formats/gpx.js';
import { logError, logInfo } from './debugOverlay.js';

// Which folder the mirror currently writes into. Null means unsaved work,
// which lives in current/. Once a session is active, its own folder takes
// over, so ongoing edits land with the session they belong to rather than
// accumulating in current/ alongside it.
let activeSessionId = null;

export function setActiveSession(id) {
  activeSessionId = id || null;
}
export function getActiveSession() {
  return activeSessionId;
}
function baseDir() {
  return activeSessionId ? Storage.sessionDir(activeSessionId) : Storage.currentDir();
}

// The record id is part of the filename, not just the name. Two flags called
// "Water" are entirely ordinary, and without the id the second would silently
// overwrite the first. It also means a delete can reconstruct exactly the
// filename it wrote without having to list the directory.
function fileNameFor(record) {
  const base = `${record.name || 'untitled'}--${record.id}`;
  return Storage.safeFilename(base, '.gpx');
}

function documentFor(store, record) {
  if (store === 'waypoints') return { name: record.name, waypoints: [record] };
  if (store === 'routes') return { name: record.name, routes: [record] };
  return { name: record.name, tracks: [record] };
}

// Writes are serialised through a single chain. Several records can be saved
// in quick succession (an import, an undo, a route save that rebinds a dozen
// flags), and letting those interleave on the filesystem invites half-written
// files and directory-creation races.
let chain = Promise.resolve();

// ---------------------------------------------------------------------------
// Pending writes
// ---------------------------------------------------------------------------
//
// A failed mirror write used to be counted and forgotten, which meant a record
// created while storage was unavailable simply had no file and nothing ever
// said so or fixed it. The queue below remembers what still needs writing, and
// survives a restart, because storage being unavailable often outlasts the
// session that hit it.
//
// Only identity is stored, never content: for a save, the record is still in
// the database and the file can be regenerated from it at retry time, which is
// also more correct than replaying a stale copy. Deletes are the exception,
// since the record is gone, so the filename is kept for those.

const PENDING_KEY = 'mirrorPending';
let pending = [];

function loadPending() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    pending = Array.isArray(raw) ? raw : [];
  } catch (e) {
    pending = [];
  }
}
function savePending() {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch (e) { /* storage full or unavailable; the in-memory list still works */ }
}

// Keyed on store+id+action so a record failing repeatedly does not accumulate
// duplicate entries, which over a long trip with no storage would grow without
// bound.
function addPending(entry) {
  const i = pending.findIndex(p => p.store === entry.store && p.id === entry.id && p.action === entry.action);
  if (i === -1) pending.push(entry); else pending[i] = entry;
  savePending();
  notifyHealth();
}
function clearPending(store, id, action) {
  const before = pending.length;
  pending = pending.filter(p => !(p.store === store && p.id === id && p.action === action));
  if (pending.length !== before) { savePending(); notifyHealth(); }
}

let healthListener = null;
export function onMirrorHealthChange(fn) { healthListener = fn; }
function notifyHealth() {
  if (healthListener) { try { healthListener(pending.length); } catch (e) { /* never break a write */ } }
}

export function getPendingWrites() { return pending.slice(); }
export function getPendingCount() { return pending.length; }

loadPending();

function enqueue(task) {
  chain = chain.then(task).catch((e) => {
    logError(`Mirror write failed: ${e.message}`);
  });
  return chain;
}

// The filename a record was last written under, so a rename can delete the
// file it replaces. The name is part of the filename, so renaming otherwise
// writes a second file and leaves the first behind: same record, twice on
// disk, under two different names.
const lastFileName = new Map();

async function writeRecord(store, record) {
  if (!record || !record.id) return;
  const filename = fileNameFor(record);
  const xml = buildGpx(documentFor(store, record));
  try {
    await Storage.writeRecordFile(baseDir(), store, filename, xml);
  } catch (e) {
    addPending({ store, id: record.id, action: 'save', name: record.name || 'Untitled' });
    throw e;
  }
  clearPending(store, record.id, 'save');

  // Orphan cleanup, after the new file exists rather than before: if the write
  // failed, deleting the old one first would leave no copy at all.
  const previous = lastFileName.get(`${store}:${record.id}`);
  if (previous && previous !== filename) {
    try {
      await Storage.deleteRecordFile(baseDir(), store, previous);
    } catch (e) {
      addPending({ store, id: record.id, action: 'delete', filename: previous, name: record.name || 'Untitled' });
    }
  }
  lastFileName.set(`${store}:${record.id}`, filename);
}

async function removeRecord(store, record) {
  if (!record || !record.id) return;
  const filename = fileNameFor(record);
  try {
    // A record deleted before it was ever mirrored has no file, which
    // deleteRecordFile already tolerates.
    await Storage.deleteRecordFile(baseDir(), store, filename);
    lastFileName.delete(`${store}:${record.id}`);
    clearPending(store, record.id, 'delete');
    // A pending save for a record that has just been deleted is moot, and
    // retrying it would resurrect a file for something no longer in the
    // database.
    clearPending(store, record.id, 'save');
  } catch (e) {
    addPending({ store, id: record.id, action: 'delete', filename, name: record.name || 'Untitled' });
    throw e;
  }
}

const RECORD_STORES = ['waypoints', 'routes', 'tracks'];

export function startMirroring() {
  Store.onDataChange((store, action, record) => {
    if (!RECORD_STORES.includes(store)) return;
    if (!Storage.isStorageConfigured()) return;
    return enqueue(() => (action === 'delete' ? removeRecord(store, record) : writeRecord(store, record)));
  });
}

// Retries everything still outstanding. Safe to call repeatedly: successes
// drop out of the queue, failures stay, and the caller gets both counts.
export async function retryPendingWrites() {
  if (!Storage.isStorageConfigured()) return { fixed: 0, failed: pending.length };
  // Snapshot first: entries are removed from `pending` as they succeed, so
  // iterating it directly would skip items.
  const queue = pending.slice();
  let fixed = 0;
  for (const entry of queue) {
    try {
      if (entry.action === 'delete') {
        await Storage.deleteRecordFile(baseDir(), entry.store, entry.filename);
        clearPending(entry.store, entry.id, 'delete');
        fixed++;
        continue;
      }
      // Regenerated from the database rather than replayed from a stored copy,
      // so a record edited since the failure is written as it is now.
      const record = await Store.getRecord(entry.store, entry.id);
      if (!record) {
        // Deleted in the meantime, so there is nothing left to write.
        clearPending(entry.store, entry.id, 'save');
        fixed++;
        continue;
      }
      await writeRecord(entry.store, record);
      fixed++;
    } catch (e) {
      logError(`Retry failed for ${entry.name || entry.id}: ${e.message}`);
    }
  }
  return { fixed, failed: pending.length };
}

// Waits for queued writes to settle. Used before anything that reads the
// folders back, such as packaging a session for export.
export function flushMirror() {
  return chain;
}

// Writes every record currently in the database into the active folder. Used
// when a session is first saved, and as the repair path when the mirror is
// known to be behind, for instance after storage was reconnected.
export async function rebuildMirror() {
  if (!Storage.isStorageConfigured()) return { written: 0 };
  const dir = baseDir();
  await Storage.ensureRecordFolders(dir);
  const [waypoints, routes, tracks] = await Promise.all([
    Store.getWaypoints(), Store.getRoutes(), Store.getTracks()
  ]);
  let written = 0;
  for (const [store, records] of [['waypoints', waypoints], ['routes', routes], ['tracks', tracks]]) {
    for (const r of records) {
      await enqueue(() => writeRecord(store, r));
      written++;
    }
  }
  await flushMirror();
  logInfo(`Mirror rebuilt: ${written} record(s) written to ${dir}.`);
  return { written };
}
