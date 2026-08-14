// dataStore.js
//
// Persists waypoints ("flags"), planned routes, and recorded GPS tracks
// on-device. Uses IndexedDB (same DB as tiles, separate object stores)
// so everything lives locally with no account/server/cloud dependency.
// Includes GPX export so data can be backed up or moved into another
// app (Gaia, CalTopo, etc.) if wanted - one-way door out, never locked in.

const DB_NAME = 'offline-topo-data';
const DB_VERSION = 2;
const STORES = ['waypoints', 'routes', 'tracks', 'sessions'];

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Mirroring the database to GPX files on disk needs to happen on every
// mutation, and there are eighteen call sites across app.js. Hooking each one
// individually guarantees that a future nineteenth is missed, so the
// notification lives here instead, where every write already funnels through.
//
// Deliberately fire-and-forget and error-swallowing: the database write is
// authoritative and must never fail because a file could not be written.
// A list, not a single slot. Two subscribers already exist (the filesystem
// mirror and the live-session snapshot), and a single slot would have let
// whichever registered second silently replace the first.
const changeListeners = [];
export function onDataChange(fn) { changeListeners.push(fn); }
function notify(store, action, record) {
  for (const fn of changeListeners) {
    try {
      const r = fn(store, action, record);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* a listener must never break a database write */ }
  }
}

// Needed by deletes: the mirror derives a filename from the record, so it has
// to see the record before it is gone.
export async function getRecord(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function putRecord(store, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecord(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Sessions ---
// A "session" is a named snapshot of the CURRENT waypoints/routes/tracks at
// the moment you save it. Deliberately does NOT touch downloaded map tile
// data at all - that lives in a completely separate IndexedDB database
// (see tileCache.js) specifically so map downloads always persist
// regardless of what happens to session data.
// Accepts an explicit id so the caller can generate a sortable, readable one
// that doubles as the session's folder name on disk. Falls back to uid() for
// any caller that does not care.
export async function saveSession(name, id) {
  const [waypoints, routes, tracks] = await Promise.all([getAll('waypoints'), getAll('routes'), getAll('tracks')]);
  return putRecord('sessions', {
    id: id || uid(), name, waypoints, routes, tracks, savedAt: Date.now()
  });
}

// Re-snapshots an existing session in place, keeping its id and folder. A
// loaded session is live rather than frozen, so edits made while it is active
// belong to it; without this they would exist only in the working stores and
// be lost the moment another session was loaded.
export async function updateSession(id) {
  const existing = await getRecord('sessions', id);
  if (!existing) return null;
  const [waypoints, routes, tracks] = await Promise.all([getAll('waypoints'), getAll('routes'), getAll('tracks')]);
  return putRecord('sessions', { ...existing, waypoints, routes, tracks, savedAt: Date.now() });
}

// Stores a session record verbatim. saveSession(name) builds a new snapshot
// from whatever is currently loaded, which is the wrong operation when
// restoring one that already exists (it would capture the current map rather
// than the saved state, and mint a new id). Import needs this instead.
export async function putSession(session) {
  return putRecord('sessions', {
    ...session,
    id: session.id || uid(),
    savedAt: session.savedAt || Date.now()
  });
}

export async function getSessions() {
  const sessions = await getAll('sessions');
  return sessions.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteSession(id) {
  return deleteRecord('sessions', id);
}

// Wipes current working waypoints/routes/tracks. Used by "New Session"
// (after the user has confirmed) and internally by loadSession before
// restoring a snapshot. Map tiles are never touched by this.
// Wipes the working stores AND every saved session, which clearCurrentData
// deliberately does not: that one is for starting a new session and must leave
// saved ones alone. This is for the full delete, where nothing is spared.
export async function deleteAllRecords() {
  const db = await openDB();
  const stores = ['waypoints', 'routes', 'tracks', 'sessions'];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    stores.forEach(s => tx.objectStore(s).clear());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearCurrentData() {
  const db = await openDB();
  await Promise.all(['waypoints', 'routes', 'tracks'].map(store => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })));
}

export async function loadSession(id) {
  const db = await openDB();
  const session = await new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const req = tx.objectStore('sessions').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!session) throw new Error('Session not found');

  await clearCurrentData();
  await Promise.all([
    ...session.waypoints.map(w => putRecord('waypoints', w)),
    ...session.routes.map(r => putRecord('routes', r)),
    ...session.tracks.map(t => putRecord('tracks', t))
  ]);
  return session;
}

// Quick check used to decide whether "New Session" needs to warn about
// losing unsaved work.
export async function hasAnyCurrentData() {
  const [waypoints, routes, tracks] = await Promise.all([getAll('waypoints'), getAll('routes'), getAll('tracks')]);
  return waypoints.length > 0 || routes.length > 0 || tracks.length > 0;
}

// --- Waypoints ---
// Acts as an upsert: pass an object with an existing `id` to update it in
// place (used for renaming and renumbering), or omit `id` to create a new
// flag with a fresh one.
export async function saveWaypoint({ id, lat, lng, name, notes, iconType, createdAt, boundRouteId, routeDistance }) {
  const rec = await putRecord('waypoints', {
    id: id || uid(),
    lat, lng, name, notes,
    iconType: iconType || 'flag', // default for backward compatibility with flags saved before this feature existed
    createdAt: createdAt || Date.now(),
    // boundRouteId/routeDistance: which route (if any) this flag is bound
    // to, and its distance-along-that-route - undefined for the vast
    // majority of flags that were never bound. routeDistance is what lets
    // "next waypoint" ordering during navigation just be a sort/compare,
    // instead of re-projecting every bound flag onto the route on every
    // GPS tick.
    boundRouteId: boundRouteId ?? null,
    routeDistance: typeof routeDistance === 'number' ? routeDistance : null
  });
  notify('waypoints', 'save', rec);
  return rec;
}
export async function getWaypoints() { return getAll('waypoints'); }
export async function deleteWaypoint(id) {
  // Read before delete: the mirror derives its filename from the record,
  // so waiting until after the row is gone would leave an orphaned file.
  const rec = await getRecord('waypoints', id);
  await deleteRecord('waypoints', id);
  notify('waypoints', 'delete', rec || { id });
}

// --- Planned routes ---
// Upsert: pass an existing `id` to update a route in place (used when
// loading a saved route back into edit mode and re-finishing it), or omit
// it to create a new one.
export async function saveRoute({ id, name, points, createdAt }) {
  // points = [{lat, lng}, ...]
  const rec = await putRecord('routes', { id: id || uid(), name, points, createdAt: createdAt || Date.now() });
  notify('routes', 'save', rec);
  return rec;
}
export async function getRoutes() { return getAll('routes'); }
export async function deleteRoute(id) {
  // Read before delete: the mirror derives its filename from the record,
  // so waiting until after the row is gone would leave an orphaned file.
  const rec = await getRecord('routes', id);
  await deleteRecord('routes', id);
  notify('routes', 'delete', rec || { id });
}

// --- Recorded GPS tracks ---
export async function saveTrack({ id, name, points, startedAt, endedAt, createdAt }) {
  // points = [{lat, lng, altitude, timestamp}, ...]
  const rec = await putRecord('tracks', { id: id || uid(), name, points, startedAt, endedAt, createdAt: createdAt || Date.now() });
  notify('tracks', 'save', rec);
  return rec;
}
export async function getTracks() { return getAll('tracks'); }
export async function deleteTrack(id) {
  // Read before delete: the mirror derives its filename from the record,
  // so waiting until after the row is gone would leave an orphaned file.
  const rec = await getRecord('tracks', id);
  await deleteRecord('tracks', id);
  notify('tracks', 'delete', rec || { id });
}

// GPX generation moved to formats/gpx.js. The version that lived here only
// ever emitted <trk> with no timestamps, could not represent waypoints or
// routes, and was never called by anything. Its escapeXml helper went with it.
