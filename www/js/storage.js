// storage.js
//
// Handles the on-device "storage folder" setup and export/import of all
// app data. Two different kinds of storage are deliberately kept separate
// here, and it's worth being upfront about the distinction:
//
// 1. LIVE data (map tiles, flags, routes, tracks, sessions, layer presets,
//    settings) stays in IndexedDB/localStorage, which is what the browser
//    engine actually needs for fast reads while the map is in active use.
//    Map tiles alone can be hundreds of MB - that's not something a plain
//    text/JSON file store could handle responsively.
// 2. This module adds an EXPORT/BACKUP path on top of that: writing a
//    single JSON snapshot of everything except the map tiles themselves
//    (which stay cached from their original re-downloadable sources) to a
//    real file in the folder the user chooses, and reading it back in.
//    That's what "setting up storage" means in Settings - establishing
//    where backups go, not relocating the live app data itself.

import * as Store from './dataStore.js';

let CapFilesystem = null;
let CapAllFilesAccess = null;
try {
  // eslint-disable-next-line no-undef
  CapFilesystem = Capacitor?.Plugins?.Filesystem || null;
  // eslint-disable-next-line no-undef
  CapAllFilesAccess = Capacitor?.Plugins?.AllFilesAccess || null;
} catch (e) {
  CapFilesystem = null;
  CapAllFilesAccess = null;
}

// Renamed from 'Cairn' in the Datum rebrand. NOTE: this changes where
// backups are written. Anyone who already had backups in a "Cairn" folder
// will still have them - untouched, on disk - but the app will now look in
// "Datum" and won't list them. Moving the old files across (or re-picking
// the folder) is the migration.
export const STORAGE_DIR = 'Datum'; // subfolder created under wherever the user picks

export function isFilesystemAvailable() {
  return !!CapFilesystem;
}

// ---------- All Files Access (needed only for the real folder browser -
// the Documents/Downloads choice below works without it) ----------
export function isAllFilesAccessPluginAvailable() {
  return !!CapAllFilesAccess;
}

export async function isAllFilesAccessGranted() {
  if (!CapAllFilesAccess) return false;
  const res = await CapAllFilesAccess.isGranted();
  return !!res.granted;
}

export async function requestAllFilesAccess() {
  if (!CapAllFilesAccess) throw new Error('AllFilesAccess plugin not available - run "npm run fix-manifest" and rebuild.');
  await CapAllFilesAccess.requestAccess(); // sends the user to a system Settings screen; resolves immediately, doesn't wait for their choice
}

// ---------- Real folder browsing, once All Files Access is granted -
// lists real subfolders under the external storage root. ----------
export async function listFolders(relativePath) {
  if (!CapFilesystem) throw new Error('Filesystem access is not available in this environment.');
  const res = await CapFilesystem.readdir({ path: relativePath, directory: 'EXTERNAL_STORAGE' });
  return res.files.filter(f => f.type === 'directory').map(f => f.name).sort((a, b) => a.localeCompare(b));
}

// ---------- Storage location setup and backup export/import ----------
// `relativePath` is the folder the user browsed to and picked (relative to
// the external storage root) - '' means the storage root itself. Kept
// optional so the older Documents/Downloads dialog (which only ever
// passes a `directory` constant, no sub-path) still works unchanged.
function backupDir(relativePath) {
  return relativePath ? `${relativePath}/${STORAGE_DIR}` : STORAGE_DIR;
}

export async function setupStorage(directory, relativePath = '') {
  if (!CapFilesystem) throw new Error('Filesystem access is not available in this environment.');
  await CapFilesystem.requestPermissions();
  const dir = backupDir(relativePath);
  try {
    await CapFilesystem.mkdir({ path: dir, directory, recursive: true });
  } catch (e) {
    // mkdir throws if the folder already exists - that's fine, not a real error.
    if (!/exist/i.test(e.message || '')) throw e;
  }
  // Write a small marker file so a future export/import has something to
  // confirm access against, and so the user can see the folder is real by
  // browsing to it themselves.
  await CapFilesystem.writeFile({
    path: `${dir}/README.txt`,
    data: 'This folder holds Datum app data.\n\n'
      + 'flags/ routes/ tracks/ sessions/ contain GPX files, the standard format\n'
      + 'used by Garmin, Gaia GPS, CalTopo, OsmAnd and most handheld GPS units.\n'
      + 'You can open these in those apps, and you can drop GPX files from them\n'
      + 'into these folders and use "Import from folder" in Datum.\n\n'
      + 'A file in sessions/ holds flags, routes and tracks together, since one GPX\n'
      + 'document can carry all three.\n\n'
      + 'presets/ contains one file per saved layer preset. These describe layer\n'
      + 'order, visibility and transparency only, with no locations in them at all.\n'
      + 'Use "Load presets from folder" to bring in one someone sent you.\n\n'
      + 'backups/ holds whole-app backups, written only when you take a backup from\n'
      + 'Settings. They are not created automatically.\n\n'
      + 'Note that flags, routes, tracks and sessions contain locations. Before\n'
      + 'sharing one publicly, consider the export options in Datum for leaving out\n'
      + 'times and for trimming the ends of tracks, which often start at home.\n\n'
      + 'Map tiles are not stored here. They stay cached on the device and can always\n'
      + 'be re-downloaded from Settings.',
    directory,
    encoding: 'utf8'
  });
  localStorage.setItem('storageConfigured', 'true');
  localStorage.setItem('storageDirectory', directory);
  localStorage.setItem('storageRelativePath', relativePath);
  return true;
}

export function getConfiguredDirectory() {
  return localStorage.getItem('storageDirectory') || 'DOCUMENTS';
}

export function getConfiguredRelativePath() {
  return localStorage.getItem('storageRelativePath') || '';
}

// Android's public downloads folder is "Download", singular, and Capacitor's
// Filesystem has no Directory constant for it: ExternalStorage is the storage
// ROOT. Writing there with an empty relative path puts everything in
// /storage/emulated/0/Datum while the UI claims "Downloads/Datum".
export const DOWNLOADS_RELATIVE_PATH = 'Download';

// The actual on-disk location, derived from what is stored rather than guessed
// from the directory constant. The UI previously inferred the label from the
// directory alone and ignored relativePath entirely, so it reported
// "Downloads/Datum" for files written to the storage root, and reported the
// wrong folder for anyone who had browsed to a custom one. Files were being
// written correctly the whole time; only the reported location was wrong,
// which is a worse failure than an error because nothing looks broken.
export function getConfiguredPathLabel() {
  if (!isStorageConfigured()) return null;
  const root = getConfiguredDirectory() === 'DOCUMENTS' ? 'Documents' : 'Internal storage';
  const rel = getConfiguredRelativePath();
  return rel ? `${root}/${rel}/${STORAGE_DIR}` : `${root}/${STORAGE_DIR}`;
}

export function isStorageConfigured() {
  return localStorage.getItem('storageConfigured') === 'true';
}

async function gatherAllData() {
  const [waypoints, routes, tracks, sessions] = await Promise.all([
    Store.getWaypoints(), Store.getRoutes(), Store.getTracks(), Store.getSessions()
  ]);
  return {
    exportedAt: new Date().toISOString(),
    waypoints, routes, tracks, sessions,
    layerStack: JSON.parse(localStorage.getItem('layerStack') || 'null'),
    layerPresets: JSON.parse(localStorage.getItem('layerPresets') || '[]'),
    savedRegions: JSON.parse(localStorage.getItem('savedRegions') || '[]'),
    debugMode: localStorage.getItem('debugMode') === 'true'
  };
}

// Folder layout under the user's chosen directory.
//
//   Datum/
//     current/                 the live, unsaved session
//       waypoints/ routes/ tracks/
//     sessions/<session-id>/   one folder per saved session
//       waypoints/ routes/ tracks/
//     presets/                 layer presets (.datum-preset.json, Datum only)
//     exports/                 packaged single-file session exports (.gpx)
//     backups/                 whole-app JSON
//
// Folder names use GPX's own vocabulary, so waypoints/ rather than flags/: a
// Datum flag and a GPX <wpt> are the same record, and a folder name that
// disagrees with the file contents helps nobody.
export const RECORD_FOLDERS = ['waypoints', 'routes', 'tracks'];

export const SHARE_FOLDERS = {
  current: 'current',
  sessions: 'sessions',
  presets: 'presets',
  backups: 'backups'
};

// Written by the earlier flat layout and no longer used. Records now live only
// under current/ or a session folder, so these are stale duplicates rather
// than a second home for anything. Listed so they can be found and cleaned up
// deliberately, never deleted silently: they still contain real data.
export const LEGACY_FOLDERS = ['flags', 'routes', 'tracks', 'exports'];

// Counts what is left behind by the old layout, including loose .gpx files
// sitting directly in sessions/ rather than inside a session folder.
export async function findLegacyLeftovers() {
  if (!CapFilesystem || !isStorageConfigured()) return { folders: [], looseSessionFiles: [], total: 0 };
  const root = datumRoot();
  const folders = [];
  for (const name of LEGACY_FOLDERS) {
    const count = await countFilesUnder(`${root}/${name}`);
    if (count) folders.push({ name, count });
  }
  // A packaged session export used to be written straight into sessions/,
  // where it sits confusingly beside the session folders themselves.
  const looseSessionFiles = [];
  for (const entry of await listDirEntries(`${root}/${SHARE_FOLDERS.sessions}`)) {
    const name = entry.name || entry;
    if ((entry.type || '') !== 'directory' && /\.gpx$/i.test(name)) looseSessionFiles.push(name);
  }
  const total = folders.reduce((n, f) => n + f.count, 0) + looseSessionFiles.length;
  return { folders, looseSessionFiles, total };
}

export async function removeLegacyLeftovers() {
  if (!CapFilesystem || !isStorageConfigured()) return 0;
  const root = datumRoot();
  let removed = 0;
  for (const name of LEGACY_FOLDERS) {
    const count = await countFilesUnder(`${root}/${name}`);
    if (!count) continue;
    await deleteTreeUnchecked(`${root}/${name}`);
    removed += count;
  }
  for (const entry of await listDirEntries(`${root}/${SHARE_FOLDERS.sessions}`)) {
    const name = entry.name || entry;
    if ((entry.type || '') === 'directory' || !/\.gpx$/i.test(name)) continue;
    try {
      await CapFilesystem.deleteFile({ path: `${root}/${SHARE_FOLDERS.sessions}/${name}`, directory: getConfiguredDirectory() });
      removed++;
    } catch (e) { /* already gone */ }
  }
  return removed;
}

function shareDir(kind) {
  return `${backupDir(getConfiguredRelativePath())}/${SHARE_FOLDERS[kind]}`;
}

async function ensureDir(path) {
  // mkdir rejects when the directory already exists on some Capacitor
  // versions, so that specific rejection is expected. Every other failure
  // (permission revoked, storage unmounted, disk full, the user deleting the
  // folder out from under the app) is real and must not be swallowed: the
  // write that follows would then fail into the same silence and the export
  // would report success having written nothing.
  try {
    await CapFilesystem.mkdir({ path, directory: getConfiguredDirectory(), recursive: true });
    return;
  } catch (e) {
    const msg = String(e && e.message || e);
    const alreadyExists = /exist/i.test(msg);
    if (!alreadyExists) {
      throw new Error(`Could not create folder "${path}": ${msg}`);
    }
  }
  // Confirmed rather than assumed. "Already exists" is matched on message
  // text, which varies by platform and version, so a differently-worded
  // failure could reach here. readdir on a missing directory throws, which
  // turns a silent write failure into a clear one.
  try {
    await CapFilesystem.readdir({ path, directory: getConfiguredDirectory() });
  } catch (e) {
    throw new Error(`Folder "${path}" is not available: ${String(e && e.message || e)}`);
  }
}

// Freeform user text becomes a filename. Beyond path separators, Android's
// FAT-derived external storage rejects several characters outright, and a name
// that is empty after stripping would produce a hidden dotfile.
// Session ids reach the filesystem as directory names, so they are validated
// rather than trusted. This is the single gate every destructive path goes
// through; see deleteSessionFolder for why that matters.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{3,80}$/;
export function isSafeSessionId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..');
}

// Sortable and readable: 20260811T134549-pusch-ridge. Sorts chronologically in
// any file manager and says what it is without being opened. The slug comes
// from the name at creation time and is never recomputed, because renaming
// must not move a directory.
export function makeSessionId(name) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `${ts}-${slug}` : ts;
}

function datumRoot() {
  return backupDir(getConfiguredRelativePath());
}
export function currentDir() {
  return `${datumRoot()}/${SHARE_FOLDERS.current}`;
}
export function sessionDir(id) {
  if (!isSafeSessionId(id)) throw new Error(`Refusing to build a path from an unsafe session id: ${JSON.stringify(id)}`);
  return `${datumRoot()}/${SHARE_FOLDERS.sessions}/${id}`;
}

// Creates the waypoints/routes/tracks trio inside a session or current folder.
export async function ensureRecordFolders(baseDir) {
  for (const f of RECORD_FOLDERS) await ensureDir(`${baseDir}/${f}`);
}

// ---------------------------------------------------------------------------
// Deletion. Treat everything below as the highest-risk code in the app.
// ---------------------------------------------------------------------------
//
// Deleting a session removes a directory tree from external storage, and a
// session folder is frequently the only remaining copy of an old trip. The
// failure that matters is not an error, it is a path that silently resolves
// one level too high: if an id were ever empty or malformed, a naive join
// would produce ".../sessions/" and take every session with it.
//
// Hence the id is validated against a strict pattern, the resolved path is
// re-checked to sit strictly inside the sessions folder, and the delete
// refuses rather than guessing. sessionDir() throws on a bad id before a path
// is even built, so this is a second gate rather than the only one.

async function listDirEntries(path) {
  try {
    const res = await CapFilesystem.readdir({ path, directory: getConfiguredDirectory() });
    return res.files || [];
  } catch (e) {
    return [];
  }
}

// Counts what a delete would remove, so a confirmation can state it rather
// than asking the user to approve an unknown quantity.
export async function countFilesUnder(path) {
  if (!CapFilesystem || !isStorageConfigured()) return 0;
  let total = 0;
  for (const entry of await listDirEntries(path)) {
    const name = entry.name || entry;
    if ((entry.type || '') === 'directory') total += await countFilesUnder(`${path}/${name}`);
    else total++;
  }
  return total;
}

async function deleteTreeUnchecked(path) {
  for (const entry of await listDirEntries(path)) {
    const name = entry.name || entry;
    const child = `${path}/${name}`;
    if ((entry.type || '') === 'directory') await deleteTreeUnchecked(child);
    else {
      try {
        await CapFilesystem.deleteFile({ path: child, directory: getConfiguredDirectory() });
      } catch (e) { /* already gone */ }
    }
  }
  try {
    await CapFilesystem.rmdir({ path, directory: getConfiguredDirectory(), recursive: true });
  } catch (e) { /* already gone, or still non-empty because a child failed */ }
}

export async function deleteSessionFolder(id) {
  if (!CapFilesystem || !isStorageConfigured()) return false;
  // Gate one: the id itself. Never derived from a display name, which is
  // freeform user text and could contain anything.
  if (!isSafeSessionId(id)) {
    throw new Error(`Refusing to delete: unsafe session id ${JSON.stringify(id)}`);
  }
  const root = `${datumRoot()}/${SHARE_FOLDERS.sessions}`;
  const target = `${root}/${id}`;
  // Gate two: the resolved path must sit strictly inside the sessions folder
  // with a single non-empty final segment. This catches a malformed root as
  // well as a malformed id.
  const finalSegment = target.slice(root.length + 1);
  if (!target.startsWith(`${root}/`) || !finalSegment || finalSegment.includes('/')) {
    throw new Error(`Refusing to delete: "${target}" is not a single session folder`);
  }
  await deleteTreeUnchecked(target);
  return true;
}

// Empties the live session folder without removing it. Deliberately a separate
// function from the session delete path so the two cannot be confused at a
// call site.
export async function clearCurrentFolder() {
  if (!CapFilesystem || !isStorageConfigured()) return;
  const dir = currentDir();
  for (const folder of RECORD_FOLDERS) await deleteTreeUnchecked(`${dir}/${folder}`);
  await ensureRecordFolders(dir);
}

// Writes one record file into current/ or a session folder.
export async function writeRecordFile(baseDir, folder, filename, text) {
  if (!CapFilesystem || !isStorageConfigured()) return null;
  await ensureDir(`${baseDir}/${folder}`);
  await CapFilesystem.writeFile({
    path: `${baseDir}/${folder}/${filename}`,
    data: text,
    directory: getConfiguredDirectory(),
    encoding: 'utf8'
  });
  return filename;
}

export async function readRecordFile(baseDir, folder, filename) {
  if (!CapFilesystem || !isStorageConfigured()) throw new Error('Storage folder is not configured.');
  const res = await CapFilesystem.readFile({
    path: `${baseDir}/${folder}/${filename}`, directory: getConfiguredDirectory(), encoding: 'utf8'
  });
  return res.data;
}

export async function listRecordFiles(baseDir, folder, extension) {
  if (!CapFilesystem || !isStorageConfigured()) return [];
  return (await listDirEntries(`${baseDir}/${folder}`))
    .filter(e => (e.type || '') !== 'directory')
    .map(e => e.name || e)
    .filter(n => !extension || n.endsWith(extension))
    .sort();
}

// The names of every saved session folder, used to find files to import.
// Anything that is not a valid session id is skipped rather than trusted,
// since these names feed straight back into path building.
export async function listSessionFolders() {
  if (!CapFilesystem || !isStorageConfigured()) return [];
  return (await listDirEntries(`${datumRoot()}/${SHARE_FOLDERS.sessions}`))
    .filter(e => (e.type || '') === 'directory')
    .map(e => e.name || e)
    .filter(isSafeSessionId);
}

// The packaged single-file export, written inside the session's own folder
// rather than loose in sessions/ where it sat confusingly beside the folders.
export async function writeSessionPackage(sessionDirPath, filename, text) {
  if (!CapFilesystem || !isStorageConfigured()) return null;
  await CapFilesystem.writeFile({
    path: `${sessionDirPath}/${filename}`,
    data: text,
    directory: getConfiguredDirectory(),
    encoding: 'utf8'
  });
  return filename;
}

export async function deleteRecordFile(baseDir, folder, filename) {
  if (!CapFilesystem || !isStorageConfigured()) return;
  try {
    await CapFilesystem.deleteFile({ path: `${baseDir}/${folder}/${filename}`, directory: getConfiguredDirectory() });
  } catch (e) { /* already gone */ }
}

export function safeFilename(name, extension) {
  const safe = String(name)
    .replace(/[\/\\:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
  return `${safe || 'untitled'}${extension}`;
}

// Returns the filename written, or null when storage is not configured, which
// callers treat as "skip quietly" rather than as an error.
export async function writeShareFile(kind, filename, text) {
  if (!CapFilesystem || !isStorageConfigured()) return null;
  const dir = shareDir(kind);
  await ensureDir(dir);
  await CapFilesystem.writeFile({
    path: `${dir}/${filename}`,
    data: text,
    directory: getConfiguredDirectory(),
    encoding: 'utf8'
  });
  return filename;
}

export async function deleteShareFile(kind, filename) {
  if (!CapFilesystem || !isStorageConfigured()) return;
  try {
    await CapFilesystem.deleteFile({ path: `${shareDir(kind)}/${filename}`, directory: getConfiguredDirectory() });
  } catch (e) {
    // Already gone, or never written because storage was configured after the
    // record was created. Not worth surfacing.
  }
}

export async function listShareFiles(kind, extension) {
  if (!CapFilesystem || !isStorageConfigured()) return [];
  try {
    const res = await CapFilesystem.readdir({ path: shareDir(kind), directory: getConfiguredDirectory() });
    return res.files.map(f => f.name).filter(n => !extension || n.endsWith(extension)).sort();
  } catch (e) {
    return [];
  }
}

export async function readShareFile(kind, filename) {
  if (!CapFilesystem || !isStorageConfigured()) throw new Error('Storage folder is not configured.');
  const res = await CapFilesystem.readFile({
    path: `${shareDir(kind)}/${filename}`, directory: getConfiguredDirectory(), encoding: 'utf8'
  });
  return res.data;
}

export const PRESET_EXTENSION = '.datum-preset.json';

export async function writePresetFile(preset) {
  const filename = safeFilename(preset.name, PRESET_EXTENSION);
  // Self-describing on purpose: a shared file lands in someone else's
  // Downloads with no context, so it states what it is and which schema it
  // follows rather than being a bare array.
  return writeShareFile('presets', filename, JSON.stringify({
    format: 'datum-layer-preset',
    version: 1,
    name: preset.name,
    savedAt: new Date().toISOString(),
    stack: preset.stack
  }, null, 2));
}

export async function deletePresetFile(name) {
  return deleteShareFile('presets', safeFilename(name, PRESET_EXTENSION));
}

// Malformed or foreign files are skipped rather than aborting the scan: these
// files arrive from other people, so one bad file must not block the rest.
export async function readPresetFiles() {
  const files = await listShareFiles('presets', '.json');
  const presets = [];
  const skipped = [];
  for (const filename of files) {
    try {
      const parsed = JSON.parse(await readShareFile('presets', filename));
      if (parsed.format !== 'datum-layer-preset' || !Array.isArray(parsed.stack)) {
        skipped.push(filename);
        continue;
      }
      presets.push({
        name: typeof parsed.name === 'string' && parsed.name.trim()
          ? parsed.name
          : filename.replace(PRESET_EXTENSION, ''),
        stack: parsed.stack
      });
    } catch (e) {
      skipped.push(filename);
    }
  }
  return { presets, skipped };
}

// Configures Documents/Datum if the user has not chosen anywhere themselves.
//
// Storage previously stayed unconfigured until someone went through setup, and
// declining the onboarding prompt left it that way permanently. Every write
// then returned null and was skipped, so exports and preset files silently did
// nothing while the app looked like it was working. A sensible default means
// the feature works out of the box and choosing a folder becomes an
// adjustment rather than a prerequisite.
//
// Called lazily, at the point of the first write, rather than on launch: it
// requests storage permission, and that prompt belongs to a deliberate user
// action like exporting rather than appearing unexplained at startup.
// Reads a file Android handed us from outside the app, via the URI in a VIEW
// intent. Kept here rather than in share.js because it is a storage concern:
// the URI is usually a content:// reference owned by another app's provider,
// not a path inside Datum's own folders.
export async function readExternalFile(uri) {
  if (!CapFilesystem) throw new Error('Filesystem access is not available in this environment.');
  // No `directory` argument. That parameter resolves a path relative to one of
  // Capacitor's known roots, which is exactly wrong for an absolute URI owned
  // by someone else; passing it would send the read looking inside Datum's
  // own storage for a file that is not there.
  const res = await CapFilesystem.readFile({ path: uri, encoding: 'utf8' });
  return res.data;
}

// Copies text into one of Datum's own folders, used after importing a file
// from outside so the mirror stays complete and the same file does not have to
// be found again.
export async function adoptExternalFile(kind, filename, text) {
  return writeShareFile(kind, filename, text);
}

export async function ensureStorageConfigured() {
  if (isStorageConfigured()) return false;
  await setupStorage('DOCUMENTS', '');
  return true;
}

// Recreates the Datum folder and the README if they have gone missing since
// setup. Deleting the folder from a file manager leaves storageConfigured
// true, so every subsequent write aimed at a directory that no longer
// existed. mkdir is recursive, so this also repairs a partially deleted tree.
//
// Returns true if it had to rebuild, so the caller can say so rather than
// silently resurrecting a folder the user deliberately removed.
export async function ensureStorageRoot() {
  if (!CapFilesystem) return false;
  // Falls through to the default location rather than giving up, so a first
  // export works without the user having visited Settings at all.
  if (!isStorageConfigured()) {
    await ensureStorageConfigured();
    return true;
  }
  const dir = backupDir(getConfiguredRelativePath());
  try {
    await CapFilesystem.readdir({ path: dir, directory: getConfiguredDirectory() });
    return false;
  } catch (e) {
    // Missing rather than merely unreadable is the common case, and mkdir
    // will fail loudly for the genuinely unreadable ones.
    await setupStorage(getConfiguredDirectory(), getConfiguredRelativePath());
    return true;
  }
}

export async function exportAllData() {
  if (!CapFilesystem) throw new Error('Filesystem access is not available in this environment.');
  await ensureDir(shareDir('backups'));
  const data = await gatherAllData();
  const filename = `datum-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await CapFilesystem.writeFile({
    path: `${shareDir('backups')}/${filename}`,
    data: JSON.stringify(data, null, 2),
    directory: getConfiguredDirectory(),
    encoding: 'utf8'
  });
  return filename;
}

export async function importAllData(filename) {
  if (!CapFilesystem) throw new Error('Filesystem access is not available in this environment.');
  // Backups used to be written to the Datum root and now live in backups/.
  // Both are read, or every backup taken before this change becomes
  // unopenable, which for a backup feature is the worst possible failure.
  let res;
  try {
    res = await CapFilesystem.readFile({
      path: `${shareDir('backups')}/${filename}`,
      directory: getConfiguredDirectory(),
      encoding: 'utf8'
    });
  } catch (e) {
    res = await CapFilesystem.readFile({
      path: `${backupDir(getConfiguredRelativePath())}/${filename}`,
      directory: getConfiguredDirectory(),
      encoding: 'utf8'
    });
  }
  const data = JSON.parse(res.data);

  for (const wp of data.waypoints || []) await Store.saveWaypoint(wp);
  for (const r of data.routes || []) await Store.saveRoute(r);
  for (const t of data.tracks || []) await Store.saveTrack(t);
  // Sessions were previously gathered into the backup but never restored from
  // it, so every restore silently lost them. saveSession(name) snapshots
  // whatever is currently loaded rather than accepting a record, so the stored
  // snapshot is written directly instead of going through it.
  for (const sess of data.sessions || []) {
    if (sess && sess.id) await Store.putSession(sess);
  }

  if (data.layerStack) localStorage.setItem('layerStack', JSON.stringify(data.layerStack));
  if (data.layerPresets) localStorage.setItem('layerPresets', JSON.stringify(data.layerPresets));
  if (data.savedRegions) localStorage.setItem('savedRegions', JSON.stringify(data.savedRegions));

  return data;
}

// Lists both the new backups/ folder and the old root location, so backups
// taken before the folder split stay visible and restorable.
export async function listBackupFiles() {
  if (!CapFilesystem) return [];
  const names = new Set(await listShareFiles('backups', '.json'));
  try {
    const res = await CapFilesystem.readdir({ path: backupDir(getConfiguredRelativePath()), directory: getConfiguredDirectory() });
    res.files
      .map(f => f.name)
      // Only backup blobs from the root, not README.txt and not the share
      // folders that now sit alongside it.
      .filter(n => n.startsWith('datum-backup-') && n.endsWith('.json'))
      .forEach(n => names.add(n));
  } catch (e) { /* root unreadable, the new folder alone is fine */ }
  return Array.from(names).sort().reverse();
}
