// share.js
// Connects Datum's records to GPX files in the storage folder.
//
// Deliberately thin: formats/gpx.js knows GPX and nothing about storage,
// storage.js knows the filesystem and nothing about GPX, and this joins them.
// Keeping that seam means a second format (GeoJSON, KML) is a new module plus
// a few lines here, not a rewrite.
//
// Export is per item on purpose. Sharing one trail should never mean handing
// over the whole database, and a single "export everything" button makes that
// mistake easy to make by accident.

import * as Store from './dataStore.js';
import * as Storage from './storage.js';
import { buildGpx, parseGpx, GPX_EXTENSION } from './formats/gpx.js';

// Privacy defaults for a shared file. Both are opt-in escalations from "share
// exactly what I recorded", because a file sent to a hiking partner and a file
// posted publicly want different answers and only the user knows which is
// which.
export const DEFAULT_SHARE_OPTIONS = {
  includeTimestamps: true,
  // Separate ends: a track usually starts at one identifying place and
  // finishes at another, and they rarely want the same treatment.
  trimStartMetres: 0,
  trimEndMetres: 0
};

// Two options were dropped rather than kept at a default. "Include flags bound
// to a route" only ever applied to the per-route export, which no longer
// exists now that the mirror writes every record continuously. "Datum extras"
// controlled whether GPX <extensions> were written, and turning it off only
// cost Datum-to-Datum fidelity: extensions are schema-legal and every
// conforming reader already ignores what it does not recognise, so there was
// nothing to gain by omitting them.

function fileNameFor(name, kind) {
  return Storage.safeFilename(name || `Untitled ${kind}`, GPX_EXTENSION);
}

// Individual waypoint, route and track files are no longer written from here.
// mirror.js already writes each record to disk as it is created, into
// current/ or the active session's folder, so a separate export step wrote the
// same data a second time into a parallel set of folders. What remains is the
// packaged export: one GPX holding an entire session, which is a genuinely
// different artifact and the thing you actually hand to someone.

// Writes a whole session as a single GPX INSIDE that session's own folder,
// alongside its waypoints/routes/tracks subfolders, so everything belonging to
// a session lives in one place and nothing loose accumulates in sessions/.
export async function exportSessionPackage(session, options = DEFAULT_SHARE_OPTIONS) {
  const opts = { ...DEFAULT_SHARE_OPTIONS, ...options };
  const xml = buildGpx({
    name: session.name,
    waypoints: session.waypoints || [],
    routes: session.routes || [],
    tracks: session.tracks || []
  }, opts);
  const filename = fileNameFor(session.name, 'session');
  const dir = Storage.sessionDir(session.id);
  await Storage.ensureRecordFolders(dir);
  await Storage.writeSessionPackage(dir, filename, xml);
  return filename;
}

// Every place a GPX can legitimately be found: the live session's folders and
// each saved session's folders. Dropping a file someone sent you into
// current/waypoints, current/routes or current/tracks is how it gets picked
// up by "Import from folder".
// Which record folder an incoming file belongs in, decided by what it holds.
// A file with more than one record type has no single home, so it goes with
// whichever type dominates: a route carrying its bound waypoints is a route.
export function folderForParsed(parsed) {
  const w = parsed.waypoints.length, r = parsed.routes.length, t = parsed.tracks.length;
  if (r && !t) return 'routes';
  if (t && !r) return 'tracks';
  if (w && !r && !t) return 'waypoints';
  // Genuinely mixed (routes and tracks together). Tracks are the bulkier and
  // more distinctive record, so they decide it.
  return t ? 'tracks' : 'routes';
}

export async function importableLocations() {
  const locations = [];
  const current = Storage.currentDir();
  for (const folder of Storage.RECORD_FOLDERS) locations.push({ dir: current, folder });
  for (const id of await Storage.listSessionFolders()) {
    const dir = Storage.sessionDir(id);
    for (const folder of Storage.RECORD_FOLDERS) locations.push({ dir, folder });
  }
  return locations;
}

/**
 * Reads one GPX file and saves everything in it.
 *
 * Records are always saved as new rather than matched against existing ids.
 * An imported file is very often a copy of something already present, and
 * reusing its ids would silently overwrite local records, which for an app
 * holding the only copy of someone's field data is unacceptable. Duplicates
 * are visible and deletable; a silent overwrite is neither.
 */
// Builds an id -> record index of everything already stored, so an import can
// tell "this is the same record I already have" from "this is new". Ids are
// Date.now() base36 plus six random base36 characters, so a collision between
// two genuinely different records, even across devices, is not a practical
// concern.
export async function buildExistingIndex() {
  const [waypoints, routes, tracks] = await Promise.all([
    Store.getWaypoints(), Store.getRoutes(), Store.getTracks()
  ]);
  const index = { waypoints: new Map(), routes: new Map(), tracks: new Map() };
  waypoints.forEach(r => index.waypoints.set(r.id, r));
  routes.forEach(r => index.routes.set(r.id, r));
  tracks.forEach(r => index.tracks.set(r.id, r));
  return index;
}

// Reads a file and reports what it would do, without writing anything. The
// caller needs this to decide whether to prompt at all: asking about
// collisions before knowing there are any produces a dialog on every import.
export async function inspectGpxFile(loc, filename) {
  const text = await Storage.readRecordFile(loc.dir, loc.folder, filename);
  const parsed = parseGpx(text);
  const index = await buildExistingIndex();
  const collisions = [];
  for (const [type, records] of [['waypoints', parsed.waypoints], ['routes', parsed.routes], ['tracks', parsed.tracks]]) {
    for (const r of records) {
      if (r.sourceId && index[type].has(r.sourceId)) {
        collisions.push({ type, name: r.name, id: r.sourceId });
      }
    }
  }
  return { parsed, collisions };
}

/**
 * onCollision: 'skip' or 'update'.
 *
 * skip   leaves the local record untouched, which is what makes re-importing
 *        your own mirror a no-op rather than a duplication event.
 * update overwrites the local record with the file's version, keeping the id.
 *        Destructive with no undo, which is why the caller has to ask.
 *
 * Records with no id, or an id not present locally, are always added as new
 * regardless of this setting.
 */
export async function importGpxFile(loc, filename, onCollision = 'skip', preloadedIndex = null) {
  const text = await Storage.readRecordFile(loc.dir, loc.folder, filename);
  const parsed = parseGpx(text);
  const index = preloadedIndex || await buildExistingIndex();
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let bindingsRestored = 0;
  let bindingsDropped = 0;

  // Routes go in FIRST so their new ids exist before any waypoint that points
  // at one is saved. Doing waypoints first would mean every binding had to be
  // patched up in a second pass, which is the same work with an extra write
  // per flag and a window where the data is briefly wrong.
  const routeIdBySourceId = new Map();
  for (const r of parsed.routes) {
    const { sourceId, ...record } = r;
    const existing = sourceId ? index.routes.get(sourceId) : null;
    if (existing && onCollision === 'skip') {
      // Still mapped, so a waypoint in this file that binds to this route
      // resolves to the copy already stored rather than losing its binding
      // just because the route itself was skipped.
      routeIdBySourceId.set(sourceId, existing.id);
      skipped++;
      continue;
    }
    // Keeping the id on update is what makes it an update rather than a
    // second copy: putRecord writes over the existing key.
    const saved = await Store.saveRoute({ ...record, id: existing ? existing.id : null });
    if (sourceId) routeIdBySourceId.set(sourceId, saved.id);
    if (existing) updated++; else imported++;
  }

  for (const wp of parsed.waypoints) {
    const { sourceId, sourceBoundRouteId, ...record } = wp;
    // A binding survives only when the route it names came in from the same
    // file. Anything else would be pointing at a route id in the sender's
    // database, so the flag is saved unbound rather than holding a reference
    // that resolves to nothing or, worse, to an unrelated local route.
    const newRouteId = sourceBoundRouteId ? routeIdBySourceId.get(sourceBoundRouteId) : null;
    if (sourceBoundRouteId) {
      if (newRouteId) bindingsRestored++;
      else bindingsDropped++;
    }
    const existing = sourceId ? index.waypoints.get(sourceId) : null;
    if (existing && onCollision === 'skip') { skipped++; continue; }
    await Store.saveWaypoint({
      ...record,
      id: existing ? existing.id : null,
      boundRouteId: newRouteId || null,
      // routeDistance is only meaningful alongside a live binding; keeping it
      // on an unbound flag would leave navigation ordering reading a stale
      // distance along a route the flag is no longer attached to.
      routeDistance: newRouteId ? record.routeDistance : null
    });
    if (existing) updated++; else imported++;
  }

  for (const t of parsed.tracks) {
    const { sourceId, ...record } = t;
    const existing = sourceId ? index.tracks.get(sourceId) : null;
    if (existing && onCollision === 'skip') { skipped++; continue; }
    await Store.saveTrack({ ...record, id: existing ? existing.id : null });
    if (existing) updated++; else imported++;
  }

  return {
    imported,
    updated,
    skipped,
    waypoints: parsed.waypoints.length,
    routes: parsed.routes.length,
    tracks: parsed.tracks.length,
    bindingsRestored,
    bindingsDropped,
    errors: parsed.errors
  };
}

// Scans every GPX folder for collisions WITHOUT writing anything, so the
// caller can ask about them once up front. Deciding before the first write is
// what makes cancelling safe: there is nothing to roll back.
export async function findCollisions() {
  const index = await buildExistingIndex();
  const collisions = [];
  for (const loc of await importableLocations()) {
    for (const filename of await Storage.listRecordFiles(loc.dir, loc.folder, GPX_EXTENSION)) {
      try {
        const parsed = parseGpx(await Storage.readRecordFile(loc.dir, loc.folder, filename));
        for (const [type, records] of [['waypoints', parsed.waypoints], ['routes', parsed.routes], ['tracks', parsed.tracks]]) {
          for (const r of records) {
            if (r.sourceId && index[type].has(r.sourceId)) {
              collisions.push({ filename, type, name: r.name, id: r.sourceId });
            }
          }
        }
      } catch (e) {
        // Unreadable files are reported during the import pass itself; this
        // pass only answers "will anything be overwritten".
      }
    }
  }
  return collisions;
}

// Scans every folder a GPX can legitimately live in and imports what it finds.
// Re-importing files the mirror itself wrote is expected and harmless: id
// matching makes it a no-op rather than a duplication event.
export async function importAllFrom(_unused, onCollision = 'skip') {
  const summary = { files: 0, imported: 0, updated: 0, skipped: 0, waypoints: 0, routes: 0, tracks: 0, bindingsRestored: 0, bindingsDropped: 0, errors: [] };
  // Built once and passed down rather than rebuilt per file, which across many
  // session folders would mean re-reading the entire database repeatedly.
  const index = await buildExistingIndex();
  for (const loc of await importableLocations()) {
    for (const filename of await Storage.listRecordFiles(loc.dir, loc.folder, GPX_EXTENSION)) {
      try {
        const res = await importGpxFile(loc, filename, onCollision, index);
        summary.files++;
        summary.imported += res.imported;
        summary.updated += res.updated;
        summary.skipped += res.skipped;
        summary.waypoints += res.waypoints;
        summary.routes += res.routes;
        summary.tracks += res.tracks;
        summary.bindingsRestored += res.bindingsRestored;
        summary.bindingsDropped += res.bindingsDropped;
        // Per-file problems are collected with the filename attached rather
        // than aborting: these files come from other people, so one bad file
        // must not stop the rest importing.
        res.errors.forEach(e => summary.errors.push(`${filename}: ${e}`));
      } catch (e) {
        summary.errors.push(`${filename}: ${e.message}`);
      }
    }
  }
  return summary;
}
