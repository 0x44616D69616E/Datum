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
let pendingFailures = 0;

function enqueue(task) {
  chain = chain.then(task).catch((e) => {
    // Counted rather than surfaced per failure: if storage has gone away,
    // every subsequent record would raise its own dialog. The count is
    // reported once, by flushMirrorStatus.
    pendingFailures++;
    logError(`Mirror write failed: ${e.message}`);
  });
  return chain;
}

async function writeRecord(store, record) {
  if (!record || !record.id) return;
  const xml = buildGpx(documentFor(store, record));
  await Storage.writeRecordFile(baseDir(), store, fileNameFor(record), xml);
}

async function removeRecord(store, record) {
  if (!record || !record.id) return;
  // A record deleted before it was ever mirrored has no file, which
  // deleteRecordFile already tolerates.
  await Storage.deleteRecordFile(baseDir(), store, fileNameFor(record));
}

const RECORD_STORES = ['waypoints', 'routes', 'tracks'];

export function startMirroring() {
  Store.onDataChange((store, action, record) => {
    if (!RECORD_STORES.includes(store)) return;
    if (!Storage.isStorageConfigured()) return;
    return enqueue(() => (action === 'delete' ? removeRecord(store, record) : writeRecord(store, record)));
  });
}

// Reports accumulated failures once and resets, so a stale mirror is
// discoverable rather than being found out at the worst possible moment.
export function takeFailureCount() {
  const n = pendingFailures;
  pendingFailures = 0;
  return n;
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
