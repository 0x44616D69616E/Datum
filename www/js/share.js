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
  trimEndsMetres: 0,
  // Whether a route export also carries the flags bound to it. On by default
  // because that is what makes a shared trail complete; set false to send only
  // the line.
  includeBoundFlags: true,
  // Datum extras: icon types and flag-to-route bindings, carried in GPX's
  // <extensions> element. On keeps a Datum-to-Datum share complete; off emits
  // nothing but the elements every GPX reader already handles.
  includeDatumExtensions: true
};

function fileNameFor(name, kind) {
  return Storage.safeFilename(name || `Untitled ${kind}`, GPX_EXTENSION);
}

// A bound flag exported alone cannot keep its binding: bindings are only
// rebuildable between records in the same file, and the route is not here.
// The file still records which route it *was* bound to in its extensions, so
// importing this flag alongside that route later reconnects them.
export async function exportFlag(wp, options = DEFAULT_SHARE_OPTIONS) {
  const xml = buildGpx({ name: wp.name, waypoints: [wp] }, options);
  return Storage.writeShareFile('flags', fileNameFor(wp.name, 'flag'), xml);
}

// Bound flags travel with their route by default. A route on its own is valid
// GPX and opens fine anywhere, but in Datum a route and the flags pinned along
// it are one thing, and a file that drops half of it is not really a share of
// that trail. Including them also makes the binding recoverable on import,
// since bindings can only be rebuilt between records in the same file.
export async function exportRoute(route, options = DEFAULT_SHARE_OPTIONS) {
  const opts = { ...DEFAULT_SHARE_OPTIONS, ...options };
  const boundFlags = opts.includeBoundFlags === false
    ? []
    : (await Store.getWaypoints()).filter(wp => wp.boundRouteId === route.id);
  const xml = buildGpx({ name: route.name, routes: [route], waypoints: boundFlags }, opts);
  return Storage.writeShareFile('routes', fileNameFor(route.name, 'route'), xml);
}

export async function exportTrack(track, options = DEFAULT_SHARE_OPTIONS) {
  const xml = buildGpx({ name: track.name, tracks: [track] }, options);
  return Storage.writeShareFile('tracks', fileNameFor(track.name, 'track'), xml);
}

// A session is a snapshot of all three types, and a GPX document can hold all
// three, so this is the same builder with more of its arguments filled in.
export async function exportSession(session, options = DEFAULT_SHARE_OPTIONS) {
  const xml = buildGpx({
    name: session.name,
    waypoints: session.waypoints || [],
    routes: session.routes || [],
    tracks: session.tracks || []
  }, options);
  return Storage.writeShareFile('sessions', fileNameFor(session.name, 'session'), xml);
}

export async function listImportable(kind) {
  return Storage.listShareFiles(kind, GPX_EXTENSION);
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
export async function inspectGpxFile(kind, filename) {
  const text = await Storage.readShareFile(kind, filename);
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
export async function importGpxFile(kind, filename, onCollision = 'skip', preloadedIndex = null) {
  const text = await Storage.readShareFile(kind, filename);
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
export async function findCollisions(kinds = ['flags', 'routes', 'tracks', 'sessions']) {
  const index = await buildExistingIndex();
  const collisions = [];
  for (const kind of kinds) {
    for (const filename of await listImportable(kind)) {
      try {
        const parsed = parseGpx(await Storage.readShareFile(kind, filename));
        for (const [type, records] of [['waypoints', parsed.waypoints], ['routes', parsed.routes], ['tracks', parsed.tracks]]) {
          for (const r of records) {
            if (r.sourceId && index[type].has(r.sourceId)) {
              collisions.push({ kind, filename, type, name: r.name, id: r.sourceId });
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

// Scans every GPX folder and imports. Used by a single "import everything
// shared with me" action, since people drop files wherever their file manager
// defaults to.
export async function importAllFrom(kinds = ['flags', 'routes', 'tracks', 'sessions'], onCollision = 'skip') {
  const summary = { files: 0, imported: 0, updated: 0, skipped: 0, waypoints: 0, routes: 0, tracks: 0, bindingsRestored: 0, bindingsDropped: 0, errors: [] };
  // Built once and passed down rather than rebuilt per file, which on a folder
  // with many files would mean reading the entire database repeatedly.
  const index = await buildExistingIndex();
  for (const kind of kinds) {
    for (const filename of await listImportable(kind)) {
      try {
        const res = await importGpxFile(kind, filename, onCollision, index);
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
