// app.js - main entry point, wires everything together.

import { LAYER_SOURCES, DEFAULT_LAYER_STACK, PRESETS, ORDERED_PRESETS } from './layers.js';
import { createOfflineTileLayer, downloadRegion, deleteTilesInRegion, deleteAllTiles, getTileCacheStats, estimateStorageUsage } from './tileCache.js';
import { buildBordersLayer } from './boundariesLayer.js';
import * as Radar from './radarPlayback.js';
import * as GPS from './gps.js';
import * as Store from './dataStore.js';
import * as Geocode from './geocoding.js';
import * as Compass from './compassHeading.js';
import { logInfo, logError, setDebugEnabled, isDebugEnabled } from './debugOverlay.js';
import { mountIcons, ICONS, FLAG_TYPES } from './icons.js';
import * as Storage from './storage.js';
import * as Share from './share.js';
import * as Mirror from './mirror.js';

mountIcons();
logInfo('app.js loaded and running');

// ---------- Overlay system (sheets + dialogs share one backdrop) ----------
const backdrop = document.getElementById('backdrop');

// Dialogs that need to settle a pending promise if they are dismissed by a
// backdrop tap rather than by one of their own buttons. Without this, a
// backdrop dismiss skips the opener's cleanup(), so the promise never
// resolves (the await sits there forever) and the button handlers stay
// attached to the shared dialog for the next caller to trip over.
const dialogDismissHandlers = new Map();

// ---------- Theme ----------
// Applied at module load rather than during init, so the app never paints
// Classic for a frame and then switches. Module scripts are deferred, so
// document.body is already parsed by the time this runs.
function applyTheme(glass) {
  document.body.classList.toggle('theme-glass', !!glass);
}
applyTheme(localStorage.getItem('glassTheme') === 'true');

// Tree selection state. Declared here, above closeOverlay, and NOT down with
// the rest of the tree code: closeOverlay clears the selection when the Data
// sheet closes, and a `let` declared further down the file would still be in
// its temporal dead zone if anything ever called closeOverlay during load. A
// ReferenceError thrown from load-time code kills every remaining line of app
// init, silently. Nothing calls it at load today; this makes that not matter.
//
// Only LEAF keys are stored. A folder's checkbox state is derived from its
// leaves, which makes double-counting impossible: ticking a session and then
// one of its waypoints cannot select the same record twice.
const treeSelected = new Set();
let treeSelectMode = false;

// Makes a floating panel draggable by any part of it that is not a control.
// Pointer events rather than touch or mouse events specifically, so one code
// path covers finger, stylus and mouse.
function makeDraggable(panel) {
  let dragging = false;
  let originX = 0, originY = 0, startLeft = 0, startTop = 0;

  panel.addEventListener('pointerdown', (e) => {
    // Controls keep their own behaviour. Without this, starting a drag on the
    // slider thumb would fight the slider and neither would work properly.
    if (e.target.closest('input, button, output, select, textarea, a')) return;
    const rect = panel.getBoundingClientRect();
    // Hand off from whatever CSS was positioning the panel to plain left/top,
    // taking the measured position so nothing moves at the moment of pickup.
    //
    // Three things have to be neutralised, and missing any one of them makes
    // the panel jump on first touch:
    //   transform, used to centre both the trim panel and the dialogs
    //   right, since a dialog sets left AND right and is therefore stretched;
    //     releasing only left would collapse it to content width
    //   transition, which would otherwise animate every drag frame and make
    //     the panel lag behind the finger
    panel.style.width = `${rect.width}px`;
    panel.style.transform = 'none';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transition = 'none';
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    dragging = true;
    originX = e.clientX; originY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    panel.classList.add('is-dragging');
    // Capture so the drag survives the pointer leaving the panel, which it
    // will as soon as the panel starts moving out from under the finger.
    panel.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  panel.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = panel.getBoundingClientRect();
    // Clamped so the panel can never be dragged fully off screen, which would
    // leave no way to reach its buttons again.
    const margin = 24;
    const maxLeft = window.innerWidth - margin;
    const maxTop = window.innerHeight - margin;
    const left = Math.min(maxLeft, Math.max(margin - rect.width, startLeft + (e.clientX - originX)));
    const top = Math.min(maxTop, Math.max(0, startTop + (e.clientY - originY)));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');
    // Restored so the open/close animation still runs next time.
    panel.style.transition = '';
    try { panel.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  };
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', end);
}

// Lets a bottom sheet be pulled down by its handle, either to peek at the map
// underneath and let go, or to dismiss it entirely.
//
// The threshold is a fraction of the sheet's own height rather than a fixed
// pixel count, so a short sheet does not need the same long drag as a tall
// one. Velocity is also considered: a quick flick is unambiguous intent to
// close even if the finger never travelled far, which is how every native
// bottom sheet behaves and what a user will expect.
function makeSheetDraggable(sheet) {
  const handle = sheet.querySelector('.sheet-handle');
  if (!handle) return;

  let dragging = false;
  let startY = 0, lastY = 0, lastT = 0, velocity = 0, height = 0;

  const setOffset = (px) => { sheet.style.transform = `translateY(${px}px)`; };

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    height = sheet.getBoundingClientRect().height || 1;
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    sheet.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Downward only. Dragging up would lift the sheet past its docked position
    // and reveal the gap beneath it, which has nothing in it.
    const dy = Math.max(0, e.clientY - startY);
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt; // px per ms
    lastY = e.clientY;
    lastT = now;
    setOffset(dy);
  });

  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('is-dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }

    const dragged = Math.max(0, lastY - startY);
    const flicked = velocity > 0.55; // downward flick, px/ms
    // Inline transform is cleared either way so the class-driven transition
    // takes over; leaving it set would pin the sheet where the finger left it.
    sheet.style.transform = '';
    if (dragged > height * 0.32 || flicked) closeOverlay(sheet.id);
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
}

// Every sheet, wired once at startup.
document.querySelectorAll('.sheet').forEach(makeSheetDraggable);

// Transient notice for things that happen without the user asking. Deliberately
// not a dialog: these are informational, and a modal would interrupt whatever
// the user was doing to report something they did not request.
let toastTimer = null;
function showToast(message, ms = 3200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  // Forces a reflow so the transition runs when a toast replaces one that is
  // already showing, rather than the class change being coalesced away.
  void el.offsetWidth;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
    // Hidden only after the fade, or the element would vanish mid-transition.
    toastTimer = setTimeout(() => el.classList.add('hidden'), 200);
  }, ms);
}

function anyOverlayVisible() {
  return !!document.querySelector('.sheet:not(.hidden), .dialog:not(.hidden)');
}
function showBackdrop() {
  backdrop.classList.remove('hidden');
  requestAnimationFrame(() => backdrop.classList.add('visible'));
}

// Sheets are mutually exclusive: two stacked bottom sheets is not a state
// this UI has a way out of, so opening one clears everything else.
function openOverlay(id) {
  document.querySelectorAll('.sheet, .dialog').forEach((el) => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  showBackdrop();
}

// Dialogs deliberately do NOT hide sheets. A confirmation raised from inside
// a sheet used to dismiss that sheet, so confirming a delete dropped you back
// to the map and the sheet had to be reopened for every single item, and
// setting the storage folder gave no way to see whether it had taken without
// reopening Settings. The CSS already stacks these correctly on its own
// (.sheet is z-index 650, .dialog is 700), so nothing here needs to move; the
// blanket hide in openOverlay was the only thing in the way.
//
// Other dialogs are still cleared, because the dialogs share #dialog-confirm
// and several flows deliberately chain one dialog into the next.
function openDialog(id) {
  document.querySelectorAll('.dialog').forEach((el) => el.classList.add('hidden'));
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  // Every dialog is movable, same as the trim panel. A dialog often covers the
  // exact part of the map the decision is about, and being able to shove it
  // aside is more useful than any amount of careful default placement.
  //
  // Position is deliberately NOT persisted between openings here, unlike the
  // trim panel: dialogs are transient and appear in response to an action, so
  // one reopening in a corner because it was dragged there an hour ago would
  // read as a bug rather than as a preference.
  el.style.left = ''; el.style.top = ''; el.style.transform = '';
  el.style.right = ''; el.style.bottom = ''; el.style.width = '';
  if (!el.dataset.draggable) {
    makeDraggable(el);
    el.dataset.draggable = 'true';
    el.classList.add('draggable-panel');
  }
  showBackdrop();
}
function closeOverlay(id) {
  document.getElementById(id).classList.add('hidden');
  dialogDismissHandlers.delete(id);
  // A selection that survives the sheet closing is how someone deletes
  // something they ticked ten minutes ago and forgot about.
  if (id === 'sheet-data' && typeof resetTreeSelection === 'function') resetTreeSelection();
  // The backdrop is shared, so it can only be torn down once nothing is left
  // sitting on top of it. Closing a dialog over an open sheet used to strip
  // the dimming out from under the sheet that was still showing.
  if (anyOverlayVisible()) return;
  backdrop.classList.remove('visible');
  setTimeout(() => {
    // Re-checked on the way out: something may have opened during the 200ms
    // fade, in which case hiding the backdrop now would leave it undimmed.
    if (!anyOverlayVisible()) backdrop.classList.add('hidden');
  }, 200);
}
function toggleSheet(id) {
  const el = document.getElementById(id);
  if (el.classList.contains('hidden')) openOverlay(id);
  else closeOverlay(id);
}
// Dismisses only the topmost layer. Closing everything at once would put the
// sheet-vanishes-under-you problem straight back via a different gesture:
// tapping beside a confirmation would take the sheet with it.
backdrop.onclick = () => {
  const topDialog = document.querySelector('.dialog:not(.hidden)');
  if (topDialog) {
    const dismiss = dialogDismissHandlers.get(topDialog.id);
    if (dismiss) dismiss();
    else closeOverlay(topDialog.id);
    return;
  }
  document.querySelectorAll('.sheet:not(.hidden)').forEach((el) => closeOverlay(el.id));
};
document.querySelectorAll('.sheet-close').forEach((btn) => {
  btn.onclick = () => closeOverlay(btn.dataset.target);
});

document.getElementById('btn-layers').onclick = () => toggleSheet('sheet-layers');
document.getElementById('btn-download').onclick = () => { toggleSheet('sheet-download'); renderRegionsList('saved-map-regions-list-download', 'tile-cache-stats-download'); };
document.getElementById('btn-data').onclick = () => { toggleSheet('sheet-data'); renderDataPanel(); };
document.getElementById('btn-settings').onclick = () => toggleSheet('sheet-settings');

// ---------- FAB menu collapse ----------
// All the action buttons live behind one toggle - tap to expand, tap
// again (or tap the toggle again) to collapse.
let fabMenuOpen = false;
document.getElementById('btn-fab-menu').onclick = () => {
  fabMenuOpen = !fabMenuOpen;
  document.getElementById('fab-menu-items').classList.toggle('hidden', !fabMenuOpen);
  document.getElementById('btn-fab-menu').classList.toggle('active', fabMenuOpen);
  refreshControlLayout(); // the anchor FABs just appeared or vanished
};

// ---------- Settings ----------
const debugToggle = document.getElementById('toggle-debug-mode');
debugToggle.checked = isDebugEnabled();
debugToggle.addEventListener('change', () => setDebugEnabled(debugToggle.checked));

// ---------- Storage setup + backup/restore ----------
function refreshStorageUI() {
  const statusText = document.getElementById('storage-status-text');
  const backupActions = document.getElementById('storage-backup-actions');
  if (!Storage.isFilesystemAvailable()) {
    statusText.textContent = 'Storage setup isn\'t available in this environment.';
    return;
  }
  if (Storage.isStorageConfigured()) {
    // Straight from the stored configuration. Inferring this from the
    // directory constant alone reported a folder the files were not in.
    statusText.textContent = `Storage is set up at ${Storage.getConfiguredPathLabel()}. Map tiles stay cached separately and aren't part of backups - they can always be re-downloaded.`;
    backupActions.classList.remove('hidden');
    refreshBackupFilesList();
  } else {
    statusText.textContent = 'Not set up yet. This creates a Datum folder for your backups and for the shareable files Datum writes.';
    backupActions.classList.add('hidden');
  }
}

async function refreshBackupFilesList() {
  const listEl = document.getElementById('backup-files-list');
  const files = await Storage.listBackupFiles();
  listEl.innerHTML = '';
  if (!files.length) { listEl.innerHTML = '<li>No backups yet.</li>'; return; }
  files.forEach((filename) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${filename}</span>`;
    const importBtn = document.createElement('button');
    importBtn.textContent = 'Restore';
    importBtn.onclick = async () => {
      const ok = await askConfirm('Restore this backup?', `This adds the flags, routes, and tracks from "${filename}" to what's already on this device (it won't delete anything current).`);
      if (!ok) return;
      try {
        await Storage.importAllData(filename);
        await redrawAllDataFromStore();
        layerStack = loadLayerStack();
        renderLayerManagerUI();
        applyLayerStack();
        updateMapOverlays();
        renderLayerPresetsList();
        logInfo(`Backup "${filename}" restored.`);
      } catch (e) {
        logError(`Failed to restore backup: ${e.message}`);
      }
    };
    li.appendChild(importBtn);
    listEl.appendChild(li);
  });
}

function askStorageFolder() {
  return new Promise((resolve) => {
    openDialog('dialog-storage-folder');
    const docsBtn = document.getElementById('btn-folder-documents');
    const dlBtn = document.getElementById('btn-folder-downloads');
    const browseBtn = document.getElementById('btn-folder-browse');
    const cleanup = () => { docsBtn.onclick = null; dlBtn.onclick = null; browseBtn.onclick = null; closeOverlay('dialog-storage-folder'); };
    docsBtn.onclick = () => { cleanup(); resolve({ directory: 'DOCUMENTS', relativePath: '', label: 'Documents/Datum' }); };
    // relativePath must be 'Download' here. EXTERNAL_STORAGE is the storage
    // root, so an empty path wrote to /storage/emulated/0/Datum while telling
    // the user it was in Downloads.
    dlBtn.onclick = () => { cleanup(); resolve({ directory: 'EXTERNAL_STORAGE', relativePath: Storage.DOWNLOADS_RELATIVE_PATH, label: 'Download/Datum' }); };
    browseBtn.onclick = async () => { cleanup(); resolve(await browseForFolder()); };
    // Backdrop tap leaves the folder unchanged. Callers treat null as "no
    // selection made" already, which is the same outcome as a failed browse.
    dialogDismissHandlers.set('dialog-storage-folder', () => { cleanup(); resolve(null); });
  });
}

// Real folder browsing - requires Android's "All files access" special
// permission, which (unlike a normal runtime permission) can only be
// granted through a system Settings screen, not an in-app dialog. If
// it's not granted yet, this sends the user there and asks them to tap
// Browse again afterward - Android gives no callback for when they
// return, so there's no way to auto-resume exactly where they left off.
async function browseForFolder() {
  if (!Storage.isAllFilesAccessPluginAvailable()) {
    logError('Folder browsing needs a rebuild first - run "npm run fix-manifest" then rebuild the APK.');
    return null;
  }
  const granted = await Storage.isAllFilesAccessGranted();
  if (!granted) {
    const ok = await askConfirm(
      'Allow file access?',
      'Browsing for a folder needs "All files access." The next screen is Android\'s own settings page - turn on the toggle for Datum, then come back here and tap Browse again.'
    );
    if (ok) await Storage.requestAllFilesAccess();
    return null;
  }

  return new Promise((resolve) => {
    let currentPath = '';
    const pathEl = document.getElementById('folder-browser-path');
    const destEl = document.getElementById('folder-browser-destination');
    const listEl = document.getElementById('folder-browser-list');
    const upBtn = document.getElementById('btn-folder-browser-up');
    const selectBtn = document.getElementById('btn-folder-browser-select');
    const closeBtn = document.querySelector('.sheet-close[data-target="sheet-folder-browser"]');

    async function render() {
      pathEl.textContent = currentPath || 'Storage root';
      destEl.textContent = `${currentPath ? currentPath + '/' : ''}${Storage.STORAGE_DIR}`;
      upBtn.disabled = !currentPath;
      listEl.innerHTML = '<li><span>Loading…</span></li>';
      let folders = [];
      try {
        folders = await Storage.listFolders(currentPath);
      } catch (e) {
        logError(`Couldn't read that folder: ${e.message}`);
      }
      listEl.innerHTML = '';
      if (!folders.length) {
        const li = document.createElement('li');
        li.innerHTML = '<span><small>No subfolders here</small></span>';
        listEl.appendChild(li);
      }
      folders.forEach((name) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>📁 ${name}</span>`;
        li.onclick = () => { currentPath = currentPath ? `${currentPath}/${name}` : name; render(); };
        listEl.appendChild(li);
      });
    }

    upBtn.onclick = () => {
      if (!currentPath) return;
      currentPath = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
      render();
    };
    selectBtn.onclick = () => {
      closeOverlay('sheet-folder-browser');
      resolve({ directory: 'EXTERNAL_STORAGE', relativePath: currentPath, label: `${currentPath || 'Storage'}/Datum` });
    };
    // Backing out via the sheet's own X should resolve null, same as
    // cancelling the Documents/Downloads dialog does.
    closeBtn.onclick = () => { closeOverlay('sheet-folder-browser'); resolve(null); };

    openOverlay('sheet-folder-browser');
    render();
  });
}

document.getElementById('btn-setup-storage').onclick = async () => {
  const picked = await askStorageFolder();
  if (!picked) return; // cancelled
  try {
    await Storage.setupStorage(picked.directory, picked.relativePath);
    logInfo(`Storage set up at ${picked.label}.`);
    refreshStorageUI();
  } catch (e) {
    logError(`Failed to set up storage: ${e.message}`);
  }
};

document.getElementById('btn-export-backup').onclick = async () => {
  try {
    const filename = await Storage.exportAllData();
    logInfo(`Backup saved: ${filename}`);
    refreshBackupFilesList();
  } catch (e) {
    logError(`Failed to export backup: ${e.message}`);
  }
};

document.getElementById('btn-import-backup').onclick = () => refreshBackupFilesList();

refreshStorageUI();

// ---------- First-launch onboarding ----------
if (!localStorage.getItem('onboardingSeen')) {
  localStorage.setItem('onboardingSeen', 'true');
  openDialog('dialog-onboarding-offline');
}
document.getElementById('btn-onboarding-offline-ok').onclick = () => {
  closeOverlay('dialog-onboarding-offline');
  if (!Storage.isStorageConfigured()) {
    setTimeout(() => openDialog('dialog-onboarding-storage'), 250);
  }
};
document.getElementById('btn-onboarding-storage-later').onclick = () => closeOverlay('dialog-onboarding-storage');
document.getElementById('btn-onboarding-storage-setup').onclick = async () => {
  closeOverlay('dialog-onboarding-storage');
  const picked = await askStorageFolder();
  if (!picked) return; // cancelled
  try {
    await Storage.setupStorage(picked.directory, picked.relativePath);
    logInfo(`Storage set up at ${picked.label}.`);
    refreshStorageUI();
  } catch (e) {
    logError(`Failed to set up storage: ${e.message}`);
  }
};

// ---------- In-app prompts (replace window.prompt/confirm) ----------
// Re-prompts until the name is unique (or cancelled). `taken` is the list
// of names already in use; comparison is case-insensitive and trims, since
// "My Route" and "my route " are the same name to a person reading a list.
// Appends " 2", " 3", ... to `base` until the result isn't already taken.
// An existing trailing number is stripped first, so re-suggesting from
// "My Route 2" gives "My Route 3" rather than "My Route 2 2".
function uniqueNameSuggestion(base, takenLower) {
  const trimmed = base.trim();
  // A free name is always returned untouched, trailing number or not -
  // otherwise a caller passing an already-available "Ridge 9" would get
  // "Ridge 10" for no reason.
  if (!takenLower.includes(trimmed.toLowerCase())) return trimmed;
  // Split a trailing number off the end, so "Trail 5" counts up from 6
  // rather than dropping back to a bare "Trail" - and so re-suggesting
  // from "My Route 2" gives "My Route 3", not "My Route 2 2".
  const match = trimmed.match(/^(.*?)\s+(\d+)$/);
  const stem = match ? match[1] : trimmed;
  const startAt = match ? Number(match[2]) + 1 : 2;
  for (let n = startAt; n < startAt + 10000; n++) {
    const candidate = `${stem} ${n}`;
    if (!takenLower.includes(candidate.toLowerCase())) return candidate;
  }
  return `${stem} ${Date.now()}`; // unreachable in practice, but never return a known-taken name
}

async function askUniqueName(title, defaultValue, taken, label = 'name') {
  const takenLower = taken.map(n => (n || '').trim().toLowerCase());
  // Open with a name that's already free, rather than one that will be
  // rejected the moment it's submitted.
  let suggestion = uniqueNameSuggestion(defaultValue, takenLower);
  for (;;) {
    const name = await askName(title, suggestion);
    if (name === null) return null;
    if (!takenLower.includes(name.trim().toLowerCase())) return name;
    // Still confirmed rather than silently renamed: re-prompt pre-filled
    // with the next free variant, so accepting is one tap but the name is
    // never changed without the user seeing it.
    suggestion = uniqueNameSuggestion(name, takenLower);
    await showAlert('Name already used', `Another ${label} is called "${name}". Suggested instead: "${suggestion}".`);
  }
}

function askName(title, defaultValue) {
  return new Promise((resolve) => {
    document.getElementById('name-prompt-title').textContent = title;
    const input = document.getElementById('name-prompt-input');
    input.value = defaultValue;
    openDialog('dialog-name-prompt');
    const confirmBtn = document.getElementById('btn-name-prompt-confirm');
    const cancelBtn = document.getElementById('btn-name-prompt-cancel');
    const cleanup = () => { confirmBtn.onclick = null; cancelBtn.onclick = null; closeOverlay('dialog-name-prompt'); };
    confirmBtn.onclick = () => { const v = input.value.trim() || defaultValue; cleanup(); resolve(v); };
    cancelBtn.onclick = () => { cleanup(); resolve(null); };
    // Backdrop tap means Cancel. Callers already branch on null.
    dialogDismissHandlers.set('dialog-name-prompt', () => { cleanup(); resolve(null); });
  });
}

function askConfirm(title, message) {
  return new Promise((resolve) => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const yesBtn = document.getElementById('btn-confirm-yes');
    const noBtn = document.getElementById('btn-confirm-no');
    // Both buttons are set explicitly rather than assuming whatever the last
    // caller left behind. #dialog-confirm is shared with showAlert(), which
    // relabels Yes to OK and hides No; saving and restoring that state across
    // two callers is fragile, so each opener states in full what it wants.
    yesBtn.textContent = 'Yes';
    noBtn.classList.remove('hidden');
    openDialog('dialog-confirm');
    const cleanup = () => { yesBtn.onclick = null; noBtn.onclick = null; closeOverlay('dialog-confirm'); };
    yesBtn.onclick = () => { cleanup(); resolve(true); };
    noBtn.onclick = () => { cleanup(); resolve(false); };
    // Tapping the backdrop counts as declining, matching Cancel.
    dialogDismissHandlers.set('dialog-confirm', () => { cleanup(); resolve(false); });
  });
}

// ---------- Map init ----------
const map = L.map('map', {
  zoomControl: false,
  rotate: true,
  touchRotate: true,
  rotateControl: false
}).setView([20, 0], 2);

// Both units shown at once - unlike the route/track distance displays
// elsewhere, two stacked lines here isn't clutter, and there's no reason
// to force a choice for a glanceable reference like this one.
let scaleControl = L.control.scale({ position: 'bottomleft', imperial: true, metric: true }).addTo(map);

// ---------- Handedness ----------
// Default right-handed. Everything except the scale bar flips via CSS
// variables (see the --controls-*/--info-* block in style.css); the scale
// bar is a real Leaflet control, and Leaflet has no "move this control"
// API, so it genuinely has to be removed and re-added on the other
// corner. It's recreated rather than mutated so its position option is
// actually honoured.
let leftHanded = localStorage.getItem('leftHanded') === 'true';
function applyHandedness() {
  document.body.classList.toggle('left-handed', leftHanded);
  map.removeControl(scaleControl);
  scaleControl = L.control.scale({
    position: leftHanded ? 'bottomright' : 'bottomleft',
    imperial: true,
    metric: true
  }).addTo(map);
  // Keep the credits in the OPPOSITE bottom corner from the scale bar.
  // Leaflet stacks every control sharing a corner container vertically,
  // so when both landed bottom-right the scale bar got pushed up above
  // the (tall, wrapped) attribution text - which is why it sat noticeably
  // higher in left-hand mode than right. Separating them keeps the scale
  // bar at the same height in both modes.
  if (map.attributionControl) {
    map.attributionControl.setPosition(leftHanded ? 'bottomleft' : 'bottomright');
  }
  applyScaleBarVisibility(); // the fresh control defaults to visible, so re-apply the hidden setting
}
const leftHandedToggle = document.getElementById('toggle-left-handed');
leftHandedToggle.checked = leftHanded;
leftHandedToggle.addEventListener('change', () => {
  leftHanded = leftHandedToggle.checked;
  localStorage.setItem('leftHanded', leftHanded ? 'true' : 'false');
  applyHandedness();
});

// On by default now - the route tool measures distance precisely, but a
// glanceable reference is still generally useful. Toggled from Settings
// ("Hide scale bar"). When hidden, the legend/radar overlay stack drops
// down to reclaim the space it was leaving clear above the scale bar,
// rather than leaving that gap empty.
let scaleBarHidden = localStorage.getItem('hideScaleBar') === 'true';
function applyScaleBarVisibility() {
  scaleControl.getContainer().style.display = scaleBarHidden ? 'none' : '';
  document.getElementById('map-overlays-stack').classList.toggle('scale-bar-hidden', scaleBarHidden);
  // Also on body, so elements outside the overlay stack (the nav HUD and
  // nav suggestion, which sit in the same bottom band) can react to the
  // scale bar appearing/disappearing with the same offsets.
  document.body.classList.toggle('scale-bar-hidden', scaleBarHidden);
}
applyScaleBarVisibility();
// Called here, not up with its own definition: applyHandedness() re-runs
// applyScaleBarVisibility(), which reads the `scaleBarHidden` let declared
// just above - calling it any earlier would hit that variable's temporal
// dead zone and throw, killing every line of setup after it.
applyHandedness();

const hideScaleBarToggle = document.getElementById('toggle-hide-scale-bar');
hideScaleBarToggle.checked = scaleBarHidden;
hideScaleBarToggle.addEventListener('change', () => {
  scaleBarHidden = hideScaleBarToggle.checked;
  localStorage.setItem('hideScaleBar', scaleBarHidden ? 'true' : 'false');
  applyScaleBarVisibility();
});

// Unit system for every distance readout EXCEPT the scale bar above (which
// always shows both) - route/track popups, the route details sheet, the
// live route-planning pill, live track recording stats, and the saved
// routes list. Off by default (miles/feet), matching this app's other
// US-centric data sources (BLM land, US state boundaries).
const glassToggle = document.getElementById('toggle-glass-theme');
glassToggle.checked = localStorage.getItem('glassTheme') === 'true';
glassToggle.addEventListener('change', () => {
  localStorage.setItem('glassTheme', glassToggle.checked ? 'true' : 'false');
  applyTheme(glassToggle.checked);
  logInfo(`Theme: ${glassToggle.checked ? 'Liquid glass' : 'Classic'}.`);
});

let useMetric = localStorage.getItem('useMetricUnits') === 'true';
const metricToggle = document.getElementById('toggle-metric-units');
metricToggle.checked = useMetric;
metricToggle.addEventListener('change', async () => {
  useMetric = metricToggle.checked;
  localStorage.setItem('useMetricUnits', useMetric ? 'true' : 'false');
  await redrawAllDataFromStore(); // refreshes every saved route/track popup
  renderDataPanel(); // refreshes the saved routes list text
  if (planningRoute) updateRouteLine(); // refreshes the live pill/popup if mid-plan
});

let hasCenteredOnFirstFix = false;

// ---------- Generalized layer manager ----------
// Every layer - tile-based (satellite/topo/trail/landOwnership/weatherRadar)
// or vector (borders) - is represented as { id, on, opacity } in an ordered
// array. Array position 0 = rendered on top. Persisted so your order and
// opacity choices survive an app restart. Adding a brand new layer in the
// future only requires an entry in layers.js - this manager and its UI
// don't need any per-layer code.
function loadLayerStack() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('layerStack')); } catch (e) { /* ignore */ }
  if (!Array.isArray(saved)) saved = JSON.parse(JSON.stringify(DEFAULT_LAYER_STACK));

  // Reconcile with the registry - pick up newly-added layer types for
  // existing users, and drop any that no longer exist.
  const existingIds = new Set(saved.map(l => l.id));
  DEFAULT_LAYER_STACK.forEach((defaultEntry) => {
    if (!existingIds.has(defaultEntry.id)) saved.push({ ...defaultEntry });
  });
  return saved.filter(l => LAYER_SOURCES[l.id]);
}
function saveLayerStack() {
  localStorage.setItem('layerStack', JSON.stringify(layerStack));
}

let layerStack = loadLayerStack();
const activeLeafletLayers = {}; // id -> leaflet layer instance, built lazily and reused

// ---------- Weather radar playback state ----------
// Previous versions of this used two alternating tile layers (one visible,
// one preloading invisibly) to avoid a blank flash when switching frames.
// That kept producing an intermittent "blank every other frame" bug that
// resisted fixing blind - the failure mode of relying on opacity swaps
// and z-order between two live layer instances has too many moving parts
// to verify without live testing. This is a simpler, more robust design:
// ONE tile layer, and before switching its URL, the target frame's tiles
// for the current viewport are explicitly pre-fetched with plain fetch()
// calls. Since those requests hit the same CDN URLs the tile layer will
// request moments later, they land in the browser's normal HTTP cache, so
// the actual .setUrl() swap resolves instantly instead of waiting on the
// network - without needing a second layer instance at all.
// Every past/nowcast frame gets its OWN Leaflet tile layer, all built and
// added to the map (at opacity 0, except whichever is current) the first
// time the radar layer is turned on. Cycling frames afterward is pure
// opacity toggling between already-loaded layers - no setUrl(), no
// preload-then-swap dance, no DOM tile churn at all during playback. That
// dance is what kept causing the flicker/blank-frame behavior in earlier
// attempts; this sidesteps it entirely once the one-time upfront load
// finishes. The tradeoff is a heavier initial load (every frame's tiles
// for the current view, not just one), which is a fair trade for genuinely
// flicker-free cycling afterward.
let radarFrameList = null;
let radarFrameIndex = null;
let radarPlaying = false;
let radarPlayTimer = null;
let radarLayers = []; // one tile layer per frame, index-aligned with radarFrameList.frames
let radarLayersBuilt = false;
let radarLayersFullyLoaded = false; // true only once every layer has actually finished loading its tiles
let radarLoadError = null; // set when a load attempt fails, so the UI can show *something* instead of a stuck "Loading…"

let radarFrameListPromise = null;

async function ensureRadarFrameList() {
  if (radarFrameList) return radarFrameList;
  if (!radarFrameListPromise) {
    radarFrameListPromise = Radar.getFrameList()
      .then((list) => {
        radarFrameList = list;
        const pastCount = list.frames.filter(f => !f.isForecast).length;
        radarFrameIndex = Math.max(0, pastCount - 1);
        return list;
      })
      .catch((err) => {
        // Don't let one failed attempt (a momentary network blip, RainViewer
        // hiccup, etc.) permanently poison every future try - clearing this
        // back to null means the next toggle-on actually attempts a fresh
        // fetch instead of instantly re-failing on the same dead promise.
        radarFrameListPromise = null;
        throw err;
      });
  }
  return radarFrameListPromise;
}

async function getOrBuildLeafletLayer(id) {
  if (activeLeafletLayers[id]) return activeLeafletLayers[id];
  const source = LAYER_SOURCES[id];
  const entry = layerStack.find(l => l.id === id);
  const opacity = entry ? entry.opacity : 1;

  let layer;
  if (source.isVectorBorders) {
    layer = await buildBordersLayer(L, opacity);
  } else if (source.isRadarPlayback) {
    await ensureRadarFrameList();
    if (!radarLayersBuilt) {
      radarLayers = radarFrameList.frames.map((frame, i) =>
        Radar.buildRadarLayer(L, radarFrameList.host, frame, i === radarFrameIndex ? opacity : 0)
      );
      radarLayersBuilt = true;
      // Attach every frame right away, not just the currently-selected
      // one - attaching a layer to the map is what makes Leaflet start
      // fetching its tiles at all. Without this, every hidden frame
      // never actually began loading in the background, so the "wait
      // for all frames" check below had nothing real to wait for and
      // falsely reported them done instantly - meaning most frames were
      // still genuinely blank whenever playback actually reached them.
      radarLayers.forEach((rl) => { if (!map.hasLayer(rl)) rl.addTo(map); });
    }
    layer = radarLayers[radarFrameIndex];
  } else if (source.isCloudSatellite) {
    await ensureRadarFrameList();
    const satFrames = radarFrameList.satFrames || [];
    if (!satFrames.length) throw new Error('No satellite frames available from RainViewer.');
    const latest = satFrames[satFrames.length - 1];
    layer = Radar.buildSatelliteLayer(L, radarFrameList.host, latest, opacity);
  } else {
    layer = createOfflineTileLayer(L, source, opacity);
  }

  activeLeafletLayers[id] = layer;
  return layer;
}

// Waits for every radar frame layer to actually finish loading its tiles
// (Leaflet's 'load' event, with a per-layer timeout fallback so one slow
// tile can't hang the whole thing indefinitely). This has to happen BEFORE
// cycling is allowed - the ghosting bug was exactly this: a hidden layer
// could still be mid-load when it became the current one, so its tiles
// faded in individually as they arrived instead of all appearing at once.
//
// The `_loading` check has a real race: reading it synchronously right
// after the layer is created can read false simply because Leaflet's
// (async) tile loading hasn't started yet - not because it already
// finished - which would let cycling begin before that layer's tiles
// actually exist. Attaching the 'load' listener FIRST, then giving
// Leaflet a moment to actually start loading before checking, closes
// that gap.
async function waitForAllRadarLayersLoaded() {
  const waits = radarLayers.map((layer) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    layer.once('load', finish);
    // 15s, not 4s: all ~13 frames now load in parallel, which means
    // 100+ tile requests funneling through the browser's ~6-connections-
    // per-host limit. On mobile data that legitimately takes longer than
    // 4s, and since these timers all start together, a short timeout
    // fired for most layers and declared them "loaded" while their tiles
    // were still in flight - which is exactly the lie that let playback
    // start cycling through frames that were still blank. This is only a
    // safety valve against a genuinely hung tile; the normal path is the
    // 'load' event above, which fires as soon as a frame is really ready.
    setTimeout(finish, 15000);
    // Give Leaflet a tick to actually start loading before trusting
    // `_loading` as a signal that this layer has nothing to wait for.
    setTimeout(() => { if (!layer._loading) finish(); }, 50);
  }));
  await Promise.all(waits);
  radarLayersFullyLoaded = true;
  updateRadarPlaybackUI();
}

function setRadarFrame(index) {
  if (!radarFrameList || !radarLayersBuilt || !radarLayersFullyLoaded) return;
  const clamped = Math.max(0, Math.min(radarFrameList.frames.length - 1, index));
  const currentOpacity = (layerStack.find(l => l.id === 'weatherRadar') || {}).opacity ?? 1;

  radarLayers.forEach((layer, i) => {
    if (i !== clamped) layer.setOpacity(0);
  });
  radarFrameIndex = clamped;
  radarLayers[radarFrameIndex].setOpacity(currentOpacity);
  activeLeafletLayers.weatherRadar = radarLayers[radarFrameIndex];
  updateRadarPlaybackUI();
}

function updateRadarPlaybackUI() {
  const timeEl = document.getElementById('radar-frame-time');
  const playBtn = document.getElementById('btn-radar-play');
  if (!timeEl) return;
  if (radarLoadError) {
    timeEl.textContent = radarLoadError;
    document.getElementById('btn-radar-play').classList.add('disabled');
    document.getElementById('btn-radar-prev').classList.add('disabled');
    document.getElementById('btn-radar-next').classList.add('disabled');
    return;
  }
  if (!radarFrameList) return;
  if (!radarLayersFullyLoaded) {
    timeEl.textContent = 'Loading…';
    document.getElementById('btn-radar-play').classList.add('disabled');
    document.getElementById('btn-radar-prev').classList.add('disabled');
    document.getElementById('btn-radar-next').classList.add('disabled');
    return;
  }
  document.getElementById('btn-radar-play').classList.remove('disabled');
  document.getElementById('btn-radar-prev').classList.remove('disabled');
  document.getElementById('btn-radar-next').classList.remove('disabled');
  const frame = radarFrameList.frames[radarFrameIndex];
  timeEl.textContent = Radar.formatFrameTime(frame);
  if (playBtn) playBtn.innerHTML = radarPlaying ? ICONS.stop : ICONS.play;
}

function scheduleNextRadarFrame() {
  radarPlayTimer = setTimeout(() => {
    if (!radarPlaying) return;
    let next = radarFrameIndex + 1;
    if (next >= radarFrameList.frames.length) next = 0; // loop
    setRadarFrame(next);
    if (radarPlaying) scheduleNextRadarFrame();
  }, 300);
}

function toggleRadarPlayback() {
  radarPlaying = !radarPlaying;
  if (radarPlaying) {
    scheduleNextRadarFrame();
  } else if (radarPlayTimer) {
    clearTimeout(radarPlayTimer);
    radarPlayTimer = null;
  }
  updateRadarPlaybackUI();
}

function stopRadarPlaybackIfRunning() {
  if (radarPlaying) {
    radarPlaying = false;
    if (radarPlayTimer) clearTimeout(radarPlayTimer);
    radarPlayTimer = null;
  }
}

async function applyLayerStack() {
  for (const entry of layerStack) {
    let layer;
    try {
      layer = await getOrBuildLeafletLayer(entry.id);
    } catch (e) {
      logError(`Failed to build layer "${entry.id}": ${e.message}`);
      continue;
    }
    if (entry.on) {
      // Radar's frames show/hide via opacity (only the selected frame is
      // ever non-zero), so the generic "apply the slider opacity to the
      // layer" below must not run against radar - activeLeafletLayers
      // points at whichever frame is currently selected, and blanket-
      // setting it here fights setRadarFrame's opacity bookkeeping
      // (and leaves every OTHER frame stuck at whatever opacity it had
      // when the slider last moved while it happened to be selected).
      if (entry.id === 'weatherRadar' && radarLayersBuilt) {
        radarLayers.forEach((rl, i) => {
          rl.setOpacity(i === radarFrameIndex ? entry.opacity : 0);
          if (!map.hasLayer(rl)) rl.addTo(map);
        });
      } else {
        if (layer.setOpacity) layer.setOpacity(entry.opacity);
        else if (layer.eachLayer) layer.eachLayer(l => l.setStyle && l.setStyle({ opacity: entry.opacity }));
        if (!map.hasLayer(layer)) layer.addTo(map);
      }
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
      if (entry.id === 'weatherRadar' && radarLayersBuilt) {
        radarLayers.forEach((rl) => { if (map.hasLayer(rl)) map.removeLayer(rl); });
      }
    }
  }
  // Enforce z-order: array[0] should end up frontmost. Processing back-to-
  // front and calling bringToFront() means index 0 is called last, so it
  // wins - avoids a full remove/re-add just to reorder.
  for (let i = layerStack.length - 1; i >= 0; i--) {
    const entry = layerStack[i];
    if (!entry.on) continue;
    // Radar is many stacked frame layers, not one - ALL of them have to
    // come forward at this stack position, not just the currently-selected
    // frame that activeLeafletLayers.weatherRadar points at. Without this,
    // every non-selected frame stayed at the bottom of the tile stack,
    // buried under satellite/topo - its tiles loaded fine but were
    // invisible, which is exactly what made playback look like most
    // frames were blank.
    if (entry.id === 'weatherRadar' && radarLayersBuilt) {
      radarLayers.forEach((rl) => rl.bringToFront && rl.bringToFront());
      continue;
    }
    const layer = activeLeafletLayers[entry.id];
    if (!layer) continue;
    if (layer.bringToFront) layer.bringToFront();
    else if (layer.eachLayer) layer.eachLayer(l => l.bringToFront && l.bringToFront());
  }
}

// ---------- BLM legend (fetched live from BLM's own ArcGIS service, so it's
// always accurate and never goes stale if they change their symbology) ----------
let blmLegendCache = null;
async function fetchBlmLegend() {
  if (blmLegendCache) return blmLegendCache;
  const url = 'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_with_PriUnk/MapServer/legend?f=pjson';

  const attempt = async (n) => {
    let res;
    try {
      res = await fetch(url);
    } catch (networkErr) {
      if (n === 0) { await new Promise(r => setTimeout(r, 700)); return attempt(1); }
      throw networkErr;
    }
    if (!res.ok) {
      if (n === 0 && (res.status >= 500 || res.status === 429)) {
        await new Promise(r => setTimeout(r, 700));
        return attempt(1);
      }
      throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    }
    return res.json();
  };
  const data = await attempt(0);
  // This service publishes the SAME categories twice: an "overview" tier
  // (minScale > 0, used when zoomed out) where every single category
  // shares one identical placeholder swatch image, and a "detail" tier
  // (minScale === 0) with the real, distinct color per category. The bug
  // here was deduping by name and keeping whichever came first in the
  // array - which was always the overview tier's identical placeholder,
  // so every legend row rendered the same generic icon. Filtering to
  // minScale === 0 first picks the tier with real colors.
  const seen = new Set();
  const items = [];
  for (const layer of data.layers) {
    if (layer.minScale !== 0) continue;
    const name = layer.layerName;
    if (seen.has(name) || name === 'Surface Management Agency') continue;
    seen.add(name);
    const legendEntry = layer.legend && layer.legend[0];
    if (legendEntry) items.push({ label: name, imageData: legendEntry.imageData, contentType: legendEntry.contentType });
  }
  blmLegendCache = items;
  return items;
}

function renderLegendSwatches(container, items) {
  container.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    // Rendered larger than the source swatch (which BLM serves at ~20x20)
    // and without smoothing, so any pattern fill (stripes, checkers) used
    // for a category is actually legible instead of blurring into a
    // solid-looking blob at a tiny size.
    row.innerHTML = `<img src="data:${item.contentType};base64,${item.imageData}" width="28" height="28" style="image-rendering: pixelated; border-radius: 3px;" /><span>${item.label}</span>`;
    container.appendChild(row);
  });
}

// Real RGBA stops sampled directly from RainViewer's own published color
// table for the "Universal Blue" scheme (the one this app's tile URL
// actually requests) at https://www.rainviewer.com/files/rainviewer_api_colors_table.csv -
// not a guess. dBZ intensity thresholds (light/moderate/heavy/hail) match
// standard meteorological convention (NWS/mesonet references).
const RADAR_GRADIENT_STOPS = [
  { dbz: 0, color: '#827b69' },
  { dbz: 15, color: '#88ddee' },
  { dbz: 20, color: '#00a3e0' },
  { dbz: 30, color: '#005588' },
  { dbz: 35, color: '#ffee00' },
  { dbz: 40, color: '#ffaa00' },
  { dbz: 45, color: '#ff4400' },
  { dbz: 50, color: '#c10000' },
  { dbz: 55, color: '#ffaaff' },
  { dbz: 65, color: '#ffffff' }
];
const RADAR_DBZ_MIN = 0;
const RADAR_DBZ_MAX = 65;

function renderRadarLegend(container) {
  container.innerHTML = '';

  const gradientCss = RADAR_GRADIENT_STOPS
    .map(s => `${s.color} ${((s.dbz - RADAR_DBZ_MIN) / (RADAR_DBZ_MAX - RADAR_DBZ_MIN) * 100).toFixed(0)}%`)
    .join(', ');

  const bar = document.createElement('div');
  bar.className = 'radar-gradient-bar';
  bar.style.background = `linear-gradient(to right, ${gradientCss})`;
  container.appendChild(bar);

  const labels = document.createElement('div');
  labels.className = 'radar-gradient-labels';
  labels.innerHTML = `<span>Light</span><span>Moderate</span><span>Heavy</span><span>Hail</span>`;
  container.appendChild(labels);
}

function renderLayerManagerUI() {
  const container = document.getElementById('layer-manager-list');
  container.innerHTML = '';
  layerStack.forEach((entry) => {
    const source = LAYER_SOURCES[entry.id];
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.dataset.id = entry.id;
    row.innerHTML = `
      <button class="icon-btn tiny drag-handle" data-icon="gripHandle" data-id="${entry.id}"></button>
      <label><input type="checkbox" ${entry.on ? 'checked' : ''} data-id="${entry.id}" data-role="toggle" /> ${source.label}</label>
      <input type="range" min="0" max="100" value="${Math.round(entry.opacity * 100)}" data-id="${entry.id}" data-role="opacity" />
    `;
    container.appendChild(row);
  });
  mountIcons(container);

  container.querySelectorAll('[data-role="toggle"]').forEach(cb => cb.onchange = () => setLayerOn(cb.dataset.id, cb.checked));
  container.querySelectorAll('[data-role="opacity"]').forEach(sl => sl.oninput = () => setLayerOpacity(sl.dataset.id, sl.value / 100));
  container.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => startDrag(e, handle.dataset.id));
  });
}

// Press-and-hold drag reordering. Only the grip handle triggers this (not
// the whole row), so it doesn't fight with tapping the checkbox or
// dragging the opacity slider. Uses Pointer Events so the same code
// handles touch and mouse identically.
//
// Key idea: the dragged row is always placed at a stable ABSOLUTE target
// position (its position when the drag started, plus total pointer
// movement since then) - never at a relative offset from wherever it
// happens to sit in the DOM right now. That distinction is what actually
// fixes the jump: every time a reorder moves the row to a different index,
// its NATURAL (untransformed) position in the list changes too, so
// reapplying the same relative delta landed it in the wrong place. Instead,
// every move event measures the row's current natural position fresh and
// computes exactly the transform needed to land it back at the stable
// absolute target - regardless of how many times reordering has moved it
// underneath.
let dragState = null;

function startDrag(e, id) {
  e.preventDefault();
  const container = document.getElementById('layer-manager-list');
  const row = container.querySelector(`.layer-row[data-id="${id}"]`);
  const startRect = row.getBoundingClientRect();

  dragState = {
    id,
    container,
    pointerId: e.pointerId,
    startClientY: e.clientY,
    startTop: startRect.top, // the row's natural top at the very start of the drag - fixed for the whole gesture
    row,
    originalRects: new Map()
  };
  container.querySelectorAll('.layer-row').forEach((r) => {
    dragState.originalRects.set(r.dataset.id, r.getBoundingClientRect());
  });

  row.classList.add('dragging');
  row.setPointerCapture(e.pointerId);
  row.addEventListener('pointermove', onDragMove);
  row.addEventListener('pointerup', onDragEnd);
  row.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;

  const desiredTop = dragState.startTop + (e.clientY - dragState.startClientY);
  const currentIdx = layerStack.findIndex(l => l.id === dragState.id);
  const desiredMid = desiredTop + dragState.row.offsetHeight / 2;

  let targetIdx = 0;
  for (const entry of layerStack) {
    if (entry.id === dragState.id) continue;
    const rect = dragState.originalRects.get(entry.id);
    if (!rect) continue;
    if (desiredMid > rect.top + rect.height / 2) targetIdx++;
  }

  if (targetIdx !== currentIdx) {
    const [moved] = layerStack.splice(currentIdx, 1);
    layerStack.splice(targetIdx, 0, moved);
    renderLayerManagerUI();

    const newRow = dragState.container.querySelector(`.layer-row[data-id="${dragState.id}"]`);
    newRow.classList.add('dragging');
    newRow.setPointerCapture(dragState.pointerId);
    newRow.addEventListener('pointermove', onDragMove);
    newRow.addEventListener('pointerup', onDragEnd);
    newRow.addEventListener('pointercancel', onDragEnd);
    dragState.row = newRow;

    dragState.originalRects.clear();
    dragState.container.querySelectorAll('.layer-row').forEach((r) => {
      dragState.originalRects.set(r.dataset.id, r.getBoundingClientRect());
    });
  }

  // Always reconcile against the row's ACTUAL current natural position
  // (measured fresh, with transform cleared) rather than trusting any
  // previously-applied offset - this is what stays correct across any
  // number of reorders instead of drifting.
  dragState.row.style.transform = '';
  const naturalTop = dragState.row.getBoundingClientRect().top;
  dragState.row.style.transform = `translateY(${desiredTop - naturalTop}px)`;
}

function onDragEnd(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  dragState.row.classList.remove('dragging');
  dragState.row.style.transform = '';
  dragState.row.removeEventListener('pointermove', onDragMove);
  dragState.row.removeEventListener('pointerup', onDragEnd);
  dragState.row.removeEventListener('pointercancel', onDragEnd);
  dragState = null;
  saveLayerStack();
  applyLayerStack();
}
function setLayerOn(id, on) {
  layerStack.find(l => l.id === id).on = on;
  if (id === 'weatherRadar' && !on) stopRadarPlaybackIfRunning();
  saveLayerStack();
  renderLayerManagerUI();
  applyLayerStack();
  updateMapOverlays();
}
function setLayerOpacity(id, opacity) {
  layerStack.find(l => l.id === id).opacity = opacity;
  saveLayerStack();
  applyLayerStack();
}

// Shows/hides the floating map-overlay legends and radar controls based on
// current layer state, and populates them the first time each becomes
// visible. Called on startup and whenever a layer is toggled, so these
// stay in sync with the map regardless of which sheet (if any) is open.
// Legends are always shown at full opacity, independent of the layer's
// own transparency slider - they're a reference key, not part of the map
// imagery itself.
async function attemptLoadRadar() {
  radarLoadError = null; // clear any previous failure - this is a fresh attempt
  updateRadarPlaybackUI(); // shows "Loading…" immediately if not ready yet
  try {
    await ensureRadarFrameList();
    await getOrBuildLeafletLayer('weatherRadar'); // builds all frame layers if not already built
    await applyLayerStack(); // attaches them to the map so their tiles actually start loading
    if (!radarLayersFullyLoaded) await waitForAllRadarLayersLoaded();
    else updateRadarPlaybackUI();
  } catch (e) {
    logError(`Failed to load radar frames: ${e.message}`);
    radarLoadError = 'Couldn\'t load radar - tap to retry';
    updateRadarPlaybackUI();
  }
}

function updateMapOverlays() {
  const radarEntry = layerStack.find(l => l.id === 'weatherRadar');
  const radarOverlay = document.getElementById('map-overlay-radar');
  if (radarEntry && radarEntry.on) {
    radarOverlay.classList.remove('hidden');
    renderRadarLegend(document.getElementById('radar-legend'));
    attemptLoadRadar();
  } else {
    radarOverlay.classList.add('hidden');
  }

  const blmEntry = layerStack.find(l => l.id === 'landOwnership');
  const blmOverlay = document.getElementById('map-overlay-blm');
  if (blmEntry && blmEntry.on) {
    blmOverlay.classList.remove('hidden');
    const legendEl = document.getElementById('blm-legend');
    fetchBlmLegend()
      .then(items => renderLegendSwatches(legendEl, items))
      .catch(e => { legendEl.textContent = 'Legend unavailable.'; logError(`Failed to load BLM legend: ${e.message}`); });
  } else {
    blmOverlay.classList.add('hidden');
  }
  refreshControlLayout(); // legend set just changed - overlap may have appeared or cleared
}

document.getElementById('btn-radar-play').onclick = toggleRadarPlayback;
document.getElementById('btn-radar-prev').onclick = () => { stopRadarPlaybackIfRunning(); setRadarFrame(radarFrameIndex - 1); };
document.getElementById('btn-radar-next').onclick = () => { stopRadarPlaybackIfRunning(); setRadarFrame(radarFrameIndex + 1); };
document.getElementById('radar-frame-time').onclick = () => { if (radarLoadError) attemptLoadRadar(); };

document.querySelectorAll('.map-overlay-header').forEach((header) => {
  header.onclick = () => {
    document.getElementById(header.dataset.target).classList.toggle('collapsed');
    // Expanding or collapsing changes the stack's height, which changes
    // whether it collides with the bottom-band panels - this hook was
    // missing, so a legend opened while the route picker was up kept the
    // clearance calculated for its collapsed height and ended up behind
    // the picker (which sits at a higher z-index).
    requestAnimationFrame(refreshControlLayout);
  };
});

renderLayerManagerUI();
applyLayerStack();
updateMapOverlays();

function applyPreset(preset) {
  for (const id of Object.keys(preset)) {
    const entry = layerStack.find(l => l.id === id);
    if (!entry) continue;
    if (typeof preset[id].on === 'boolean') entry.on = preset[id].on;
    if (typeof preset[id].opacity === 'number') entry.opacity = preset[id].opacity;
  }
  saveLayerStack();
  renderLayerManagerUI();
  applyLayerStack();
}

// Built-in quick presets, shown at the top of the same unified list as
// the user's own saved presets (not as separate standalone buttons).
// Replaces the whole stack, order included. Saved presets have always worked
// this way; this is the same logic lifted out so ordered built-ins can share
// it rather than being a second implementation that drifts.
function applyOrderedStack(stack, label) {
  layerStack = JSON.parse(JSON.stringify(stack)).filter(l => LAYER_SOURCES[l.id]);
  // Pick up any layer types added since this stack was written, so an older
  // preset doesn't silently hide brand-new layers forever.
  DEFAULT_LAYER_STACK.forEach((d) => { if (!layerStack.find(l => l.id === d.id)) layerStack.push({ ...d }); });
  saveLayerStack();
  renderLayerManagerUI();
  applyLayerStack();
  updateMapOverlays();
  logInfo(`Layer preset "${label}" loaded.`);
}

// Two shapes here, deliberately. The first three use PRESETS, an unordered
// map applied over the user's existing order, which is what they have always
// done: loading "Satellite only" should not silently rearrange a stack the
// user has hand-ordered. USGS hybrid is different because its whole point is
// the ordering, so it carries a full stack instead.
const BUILT_IN_PRESETS = [
  { name: 'Satellite only', preset: PRESETS.satelliteOnly },
  { name: 'Topo only', preset: PRESETS.topoOnly },
  { name: 'Hybrid', preset: PRESETS.hybrid },
  { name: ORDERED_PRESETS.usgsHybrid.name, orderedStack: ORDERED_PRESETS.usgsHybrid.stack }
];

// ---------- User-saved layer presets (full stack: order, visibility, opacity) ----------
function getSavedLayerPresets() {
  try { return JSON.parse(localStorage.getItem('layerPresets') || '[]'); } catch (e) { return []; }
}
function saveLayerPresetsToStorage(presets) {
  localStorage.setItem('layerPresets', JSON.stringify(presets));
}

function renderLayerPresetsList() {
  const targetIds = ['saved-layer-presets-list', 'saved-layer-presets-list-data'];
  const presets = getSavedLayerPresets();

  targetIds.forEach((targetId) => {
    const listEl = document.getElementById(targetId);
    if (!listEl) return;
    listEl.innerHTML = '';

    BUILT_IN_PRESETS.forEach(({ name, preset, orderedStack }) => {
      const li = document.createElement('li');
      // Sets layer order is called out because it is the one behavioural
      // difference between the two kinds, and it is otherwise invisible until
      // after the stack has already been rearranged.
      const sub = orderedStack ? 'Built-in, sets layer order' : 'Built-in';
      li.innerHTML = `<span>${name}<br><small>${sub}</small></span>`;
      const actions = document.createElement('span');
      actions.className = 'item-actions';
      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.onclick = () => {
        if (orderedStack) applyOrderedStack(orderedStack, name);
        else applyPreset(preset);
      };
      actions.appendChild(loadBtn);
      li.appendChild(actions);
      listEl.appendChild(li);
    });

    presets.forEach((preset, index) => {
      const li = document.createElement('li');
      const onLabels = preset.stack.filter(e => e.on).length;
      li.innerHTML = `<span>${preset.name}<br><small>${onLabels} layer(s) on</small></span>`;
      const actions = document.createElement('span');
      actions.className = 'item-actions';
      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.onclick = () => applyOrderedStack(preset.stack, preset.name);
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.onclick = async () => {
        const ok = await askConfirm('Delete preset?', `Delete layer preset "${preset.name}"?`);
        if (!ok) return;
        const updated = getSavedLayerPresets().filter((_, i) => i !== index);
        saveLayerPresetsToStorage(updated);
        renderLayerPresetsList();
        // The file has to go too. Leaving it behind means the next "load from
        // folder" would resurrect the preset the user just deleted.
        try {
          await Storage.deletePresetFile(preset.name);
        } catch (e) {
          logError(`Preset deleted, but removing its file failed: ${e.message}`);
        }
      };
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      li.appendChild(actions);
      listEl.appendChild(li);
    });
  });
}
renderLayerPresetsList();

document.getElementById('btn-save-layer-preset').onclick = async () => {
  const name = await askName('Save layer preset as', `Preset ${getSavedLayerPresets().length + 1}`);
  if (name === null) return;
  const presets = getSavedLayerPresets();
  const preset = { name, stack: JSON.parse(JSON.stringify(layerStack)) };
  presets.push(preset);
  saveLayerPresetsToStorage(presets);
  renderLayerPresetsList();
  logInfo(`Layer preset "${name}" saved.`);

  // localStorage stays the source of truth and is written first. The file is
  // a mirror that exists so presets can be shared, so a filesystem problem
  // (storage not configured yet, permission revoked, card removed) must never
  // cost the user the preset they just saved.
  try {
    await Storage.ensureStorageRoot();
    const filename = await Storage.writePresetFile(preset);
    if (filename) logInfo(`Preset file written: ${Storage.getConfiguredPathLabel()}/presets/${filename}`);
    else logInfo('Preset saved. No storage folder is set, so no shareable file was written.');
  } catch (e) {
    logError(`Preset saved, but writing its shareable file failed: ${e.message}`);
  }
};

// Pulls in preset files that are on disk but not yet known to the app, which
// is how a preset someone else shared gets in. Matching is by name: a file
// whose name already exists is left alone rather than silently overwriting a
// preset the user has of their own.
document.getElementById('btn-load-presets-from-folder').onclick = async () => {
  await Storage.ensureStorageRoot();
  let result;
  try {
    result = await Storage.readPresetFiles();
  } catch (e) {
    logError(`Could not read presets folder: ${e.message}`);
    return;
  }
  const existing = getSavedLayerPresets();
  const existingNames = new Set(existing.map(p => p.name));
  const added = result.presets.filter(p => !existingNames.has(p.name));
  if (added.length) {
    saveLayerPresetsToStorage(existing.concat(added));
    renderLayerPresetsList();
  }
  const parts = [`${added.length} preset(s) added.`];
  if (result.presets.length - added.length > 0) parts.push(`${result.presets.length - added.length} already present.`);
  if (result.skipped.length) parts.push(`${result.skipped.length} file(s) skipped as not readable presets.`);
  await showAlert('Load presets from folder', parts.join('\n'));
  logInfo(`Preset import: ${parts.join(' ')}`);
};

// ---------- Filesystem mirror ----------
Mirror.startMirroring();

// A loaded session is live, not frozen: edits made while it is active belong
// to it. Re-snapshotting on every single change would rewrite every record's
// copy on each keystroke, so it is debounced and coalesced. The delay is short
// enough that closing the app shortly after an edit still captures it.
let sessionSyncTimer = null;
Store.onDataChange(() => {
  if (!currentSessionId) return;
  if (sessionSyncTimer) clearTimeout(sessionSyncTimer);
  sessionSyncTimer = setTimeout(async () => {
    sessionSyncTimer = null;
    try {
      await Store.updateSession(currentSessionId);
    } catch (e) {
      logError(`Could not update session snapshot: ${e.message}`);
    }
  }, 1500);
});

// ---------- Sharing: GPX export/import ----------
// Reads the privacy controls fresh on each export rather than caching them, so
// a change in the sheet applies to the very next export with no apply step.
// Sliders work in whole metres internally and display in the user's chosen
// units, so the stored value never drifts through a rounding trip and the
// label always matches the rest of the app.
const TRIM_MAX_METRES = 1000;

function trimLabel(metres) {
  if (useMetric) return `${metres} m`;
  return `${Math.round(metres * 3.280839895)} ft`;
}

function syncTrimUI() {
  const on = document.getElementById('share-trim-enabled').checked;
  const box = document.getElementById('share-trim-controls');
  box.classList.toggle('is-disabled', !on);
  for (const which of ['start', 'end']) {
    const slider = document.getElementById(`share-trim-${which}`);
    slider.disabled = !on;
    document.getElementById(`share-trim-${which}-out`).textContent = trimLabel(+slider.value);
  }
}

// Persisted alongside the other settings, using the same read-on-start,
// write-on-change shape the twelve existing toggles use. A privacy control
// that resets every launch is one the user will forget on exactly the run
// where it mattered.
//
// Trim is stored in metres rather than raw slider position, because the slider
// maximum is derived from the length of whatever is being exported and so
// means something different next time.
function persistShareOptions() {
  localStorage.setItem('shareIncludeTimestamps', document.getElementById('share-include-timestamps').checked ? 'true' : 'false');
  localStorage.setItem('shareTrimEnabled', document.getElementById('share-trim-enabled').checked ? 'true' : 'false');
  localStorage.setItem('shareTrimStartMetres', String(+document.getElementById('share-trim-start').value || 0));
  localStorage.setItem('shareTrimEndMetres', String(+document.getElementById('share-trim-end').value || 0));
}

function restoreShareOptions() {
  // Timestamps default OFF. A path alone shows where a trail goes; timestamps
  // also show what hours you were out, so the quieter option is the one you
  // get without having to think about it.
  document.getElementById('share-include-timestamps').checked =
    localStorage.getItem('shareIncludeTimestamps') === 'true';
  document.getElementById('share-trim-enabled').checked =
    localStorage.getItem('shareTrimEnabled') === 'true';
  document.getElementById('share-trim-start').value = +localStorage.getItem('shareTrimStartMetres') || 0;
  document.getElementById('share-trim-end').value = +localStorage.getItem('shareTrimEndMetres') || 0;
  // Must run after the checkbox is set, or the sliders stay visually disabled
  // while reporting the restored values.
  syncTrimUI();
}

document.getElementById('share-include-timestamps').addEventListener('change', persistShareOptions);
document.getElementById('share-trim-enabled').addEventListener('change', () => { syncTrimUI(); persistShareOptions(); });
for (const which of ['start', 'end']) {
  document.getElementById(`share-trim-${which}`).addEventListener('input', syncTrimUI);
  // Written on change rather than input: dragging a slider fires input on
  // every pixel, and writing to localStorage that often is wasteful.
  document.getElementById(`share-trim-${which}`).addEventListener('change', persistShareOptions);
}
restoreShareOptions();

// Read fresh on each use rather than cached, so a change applies to the very
// next action with no apply step.
function currentShareOptions() {
  const trimOn = document.getElementById('share-trim-enabled').checked;
  return {
    includeTimestamps: document.getElementById('share-include-timestamps').checked,
    trimStartMetres: trimOn ? +document.getElementById('share-trim-start').value || 0 : 0,
    trimEndMetres: trimOn ? +document.getElementById('share-trim-end').value || 0 : 0
  };
}

document.getElementById('btn-package-session').onclick = async () => {
  if (!currentSessionId) {
    await showAlert('Save the session first',
      'Packaging writes one file containing a whole session, so the session needs a name and a folder to live in. Use "Save session" first.');
    return;
  }
  try {
    await Storage.ensureStorageRoot();
    // The mirror writes per record as you go, so a queued write could still be
    // in flight. Flushing first means the package cannot miss a record that
    // was added a moment ago.
    await Mirror.flushMirror();
    const sessions = await Store.getSessions();
    const session = sessions.find(x => x.id === currentSessionId);
    if (!session) { await showAlert('Session not found', 'Could not find the saved session to package.'); return; }

    const opts = currentShareOptions();
    const filename = await Share.exportSessionPackage(session, opts);
    const notes = [];
    if (!opts.includeTimestamps) notes.push('Times were stripped.');
    if (opts.trimStartMetres) notes.push(`${trimLabel(opts.trimStartMetres)} trimmed from the start of tracks.`);
    if (opts.trimEndMetres) notes.push(`${trimLabel(opts.trimEndMetres)} trimmed from the end of tracks.`);
    await showAlert('Session packaged',
      `Written to ${Storage.getConfiguredPathLabel()}/sessions/${currentSessionId}/${filename}.${notes.length ? '\n\n' + notes.join(' ') : ''}`);
    logInfo(`Session packaged: ${filename}`);
  } catch (e) {
    logError(`Packaging failed: ${e.message}`);
    await showAlert('Packaging failed', e.message);
  }
};

// The earlier flat layout wrote records into Datum/flags, Datum/routes and
// Datum/tracks, and dropped packaged exports loose in sessions/. Nothing
// writes there any more, but the files are real data and are not deleted
// without asking.
document.getElementById('btn-tidy-storage').onclick = async () => {
  try {
    await Storage.ensureStorageRoot();
    const found = await Storage.findLegacyLeftovers();
    if (!found.total) {
      await showAlert('Nothing to tidy', 'Your storage folder is already using the current layout.');
      return;
    }
    const bits = found.folders.map(f => `${f.name}/ (${f.count} file(s))`);
    if (found.looseSessionFiles.length) bits.push(`${found.looseSessionFiles.length} loose file(s) in sessions/`);
    const ok = await askConfirm('Tidy up old folders?',
      `These are left over from an earlier layout and nothing writes to them now:\n\n${bits.join('\n')}\n\n`
      + 'Your waypoints, routes and tracks already live in current/ and your session folders, so these are duplicates. Delete them?');
    if (!ok) return;
    const removed = await Storage.removeLegacyLeftovers();
    await showAlert('Tidied up', `${removed} file(s) removed.`);
    logInfo(`Storage tidy: ${removed} legacy file(s) removed.`);
  } catch (e) {
    logError(`Tidy failed: ${e.message}`);
    await showAlert('Tidy failed', e.message);
  }
};

document.getElementById('btn-import-share').onclick = async () => {
  try {
    // Created rather than refused, so the folders exist for the user to put
    // files into. Reading an empty folder reports nothing found, which is
    // more useful than being told to go and configure something first.
    await Storage.ensureStorageRoot();
    // Collisions are found before anything is written, so cancelling here
    // leaves the database untouched with nothing to roll back.
    const collisions = await Share.findCollisions();
    let onCollision = 'skip';

    if (collisions.length) {
      // Asked once for the whole run, not per record. A folder import can hit
      // hundreds of collisions and a dialog each time would be unusable.
      const sample = collisions.slice(0, 3).map(c => `${c.name} (${c.type.replace(/s$/, '')})`).join(', ');
      const more = collisions.length > 3 ? `, and ${collisions.length - 3} more` : '';
      const update = await askConfirm(
        `${collisions.length} item(s) already exist`,
        `These files contain items already in Datum: ${sample}${more}.\n\n`
        + 'Update replaces your copies with the versions in the files. Anything you have changed locally is overwritten and cannot be recovered.\n\n'
        + 'Skip keeps your copies and imports only what is new.\n\n'
        + 'Update these items?');
      onCollision = update ? 'update' : 'skip';
    } else {
      // No collisions, so there is nothing to ask about, but import still
      // writes to the database and should not happen on a single stray tap.
      const go = await askConfirm('Import from folder?',
        'Every GPX file in current/ and your session folders will be read. Files Datum wrote itself are recognised and skipped, so nothing is duplicated and nothing you already have is changed.');
      if (!go) return;
    }

    const res = await Share.importAllFrom(undefined, onCollision);
    await redrawAllDataFromStore();
    renderDataPanel();

    const parts = [`${res.files} file(s) read.`, `${res.imported} new item(s) added.`];
    if (res.updated) parts.push(`${res.updated} existing item(s) updated.`);
    if (res.skipped) parts.push(`${res.skipped} already-present item(s) left alone.`);
    if (res.bindingsRestored) parts.push(`${res.bindingsRestored} flag binding(s) reconnected to their route.`);
    // Surfaced rather than swallowed: a flag arriving unbound when the sender
    // had it bound is a real difference in the data, and silently losing it is
    // how someone ends up wondering why navigation skips a waypoint.
    if (res.bindingsDropped) parts.push(`${res.bindingsDropped} flag(s) came in unbound because their route was not in the same file. Import that route alongside them to reconnect.`);
    // Capped so a folder full of unreadable files cannot produce a dialog
    // taller than the screen with no way to dismiss it.
    if (res.errors.length) parts.push(`\nSkipped:\n${res.errors.slice(0, 5).join('\n')}${res.errors.length > 5 ? `\n...and ${res.errors.length - 5} more` : ''}`);
    await showAlert('Import complete', parts.join(' '));
    logInfo(`GPX import: ${res.imported} added, ${res.updated} updated, ${res.skipped} skipped, from ${res.files} file(s), ${res.errors.length} problem(s).`);
  } catch (e) {
    logError(`Import failed: ${e.message}`);
    await showAlert('Import failed', e.message);
  }
};

// ---------- Opening a GPX handed to us by another app ----------
// Registered as a .gpx handler in the manifest, so tapping a route someone
// emailed you offers Datum alongside Gaia, OsmAnd and the rest. The file is
// usually a content:// URI owned by another app's provider rather than
// anything inside Datum's folders.
async function handleIncomingGpx(uri, source) {
  if (!uri) return;
  // Deliberately NOT filtered by filename. A content:// URI carries no name at
  // all (content://media/external/downloads/1000000042 is typical), so testing
  // for ".gpx" here silently discarded exactly the URIs this feature exists to
  // handle. The manifest filter has already decided the file is ours; the only
  // thing worth excluding is a web URL, which would arrive from a deep link
  // rather than a file and is not something to parse as XML.
  if (/^(https?|about|javascript):/i.test(uri)) return;

  logInfo(`Incoming file (${source}): ${uri}`);

  try {
    const { parsed, collisions, text, index } = await Share.importExternalGpx(uri);
    logInfo(`Parsed ${text.length} bytes: ${parsed.waypoints.length} flag(s), ${parsed.routes.length} route(s), ${parsed.tracks.length} track(s).`);
    const counts = `${parsed.waypoints.length} flag(s), ${parsed.routes.length} route(s), ${parsed.tracks.length} track(s)`;

    let onCollision = 'skip';
    if (collisions.length) {
      const sample = collisions.slice(0, 3).map(c => `${c.name} (${c.type.replace(/s$/, '')})`).join(', ');
      const update = await askConfirm(
        `${collisions.length} item(s) already exist`,
        `This file contains ${counts}, and some are already in Datum: ${sample}.\n\n`
        + 'Update replaces your copies. Anything you have changed locally is overwritten and cannot be recovered.\n\n'
        + 'Skip keeps your copies and imports only what is new.\n\n'
        + 'Update these items?');
      onCollision = update ? 'update' : 'skip';
    } else {
      const go = await askConfirm('Open this file?', `This file contains ${counts}. Add them to Datum?`);
      if (!go) return;
    }

    const res = await Share.commitExternalGpx(parsed, index, onCollision);
    await redrawAllDataFromStore();
    renderDataPanel();

    // Copied into Datum's own folders so the mirror stays complete and the
    // file does not have to be located again. Best effort: the import has
    // already succeeded and a failed copy should not present as a failure.
    let adopted = null;
    try {
      await Storage.ensureStorageRoot();
      // Adopted into the live session, since an incoming file is something you
      // are adding to what you are working on now.
      const folder = Share.folderForParsed(parsed);
      // A content:// URI usually ends in an opaque row id, so the last path
      // segment would save the file as something like "1000000042.gpx".
      // Falling back to the name of what is actually inside gives a file
      // someone can recognise later in a file manager.
      const fromUri = decodeURIComponent((uri.split('/').pop() || '').replace(/\?.*$/, '')).replace(/\.gpx$/i, '');
      const looksUseful = fromUri && !/^\d+$/.test(fromUri) && !/^[0-9a-f-]{16,}$/i.test(fromUri);
      const fromContent = (parsed.routes[0] || parsed.tracks[0] || parsed.waypoints[0] || {}).name;
      const base = looksUseful ? fromUri : (fromContent || 'imported');
      adopted = await Storage.writeRecordFile(Storage.currentDir(), folder, Storage.safeFilename(base, '.gpx'), text);
    } catch (e) {
      logError(`Imported, but could not copy the file into Datum's folder: ${e.message}`);
    }

    const parts = [`${res.added} new item(s) added.`];
    if (res.updated) parts.push(`${res.updated} updated.`);
    if (res.skipped) parts.push(`${res.skipped} already present, left alone.`);
    if (res.bindingsRestored) parts.push(`${res.bindingsRestored} flag binding(s) reconnected.`);
    if (res.bindingsDropped) parts.push(`${res.bindingsDropped} flag(s) came in unbound because their route was not in the file.`);
    if (adopted) parts.push(`Saved a copy as ${adopted}.`);
    await showAlert('File imported', parts.join(' '));
    logInfo(`External GPX import from ${uri}: ${res.added} added, ${res.updated} updated, ${res.skipped} skipped.`);
  } catch (e) {
    // The URI is logged deliberately. Content URIs vary a lot between file
    // managers and mail clients, and knowing the exact one that failed is the
    // only practical way to diagnose a provider Datum cannot read.
    logError(`Could not open GPX file: ${e.message} (uri: ${uri})`);
    await showAlert('Could not open file', `${e.message}\n\nIf this keeps happening, try saving the file to your device first and using Import from folder.`);
  }
}

// Both entry points are needed and they cover different cases: getLaunchUrl
// for a cold start where Datum was not running, appUrlOpen for a warm one
// where it already was. Handling only the listener misses every cold start,
// which is the common case for tapping a file.
(async () => {
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!CapApp) {
    // Not fatal, everything else works, but file-open silently does nothing
    // without it, so it needs to be visible in the log rather than guessed at.
    logError('Capacitor App plugin unavailable, so opening .gpx files from other apps will not work.');
    return;
  }
  // Listener registered FIRST. A cold start can deliver the intent before
  // getLaunchUrl resolves, and registering afterwards would miss it.
  CapApp.addListener('appUrlOpen', (data) => {
    handleIncomingGpx(data && data.url, 'appUrlOpen');
  });
  try {
    const launch = await CapApp.getLaunchUrl();
    // Logged either way. "no launch url" is the normal case for an ordinary
    // app start, and distinguishing it from "plugin never ran" is the
    // difference between a working feature and a silent one.
    if (launch && launch.url) await handleIncomingGpx(launch.url, 'getLaunchUrl');
    else logInfo('Started without a launch URL (normal app start).');
  } catch (e) {
    logError(`Could not read launch URL: ${e.message}`);
  }
})();

// ---------- Compass / map rotation ----------
// The needle SVG is drawn with "N" at 0deg (12 o'clock) by construction.
// NOTE: the rotation sign here was flipped from the previous version after
// live testing showed the needle rotating WITH the map instead of staying
// pointed at true north - leaflet-rotate's bearing sign convention turned
// out to be the opposite of what was assumed. If this still looks wrong,
// that hypothesis is now ruled out and it's worth checking the needle SVG
// orientation itself next.
const compassNeedle = document.getElementById('compass-needle');
let continuousNeedleRotation = 0;

function updateCompassDisplay() {
  const rawBearingDeg = map.getBearing ? map.getBearing() : 0;
  let delta = rawBearingDeg - (continuousNeedleRotation % 360);
  delta = ((delta + 180) % 360 + 360) % 360 - 180;
  continuousNeedleRotation += delta;
  compassNeedle.style.transform = `rotate(${continuousNeedleRotation}deg)`;
}
// Rotating the map exposes map area that was outside the previous
// axis-aligned tile range (the viewport corners sweep outward), so new tiles
// are needed. leaflet-rotate does override _getTiledPixelBounds() to compute
// the rotated range correctly, but it only registers its own rotate handler
// when `updateWhenIdle` is false, and Leaflet defaults that option to
// L.Browser.mobile. This app is Android only, so it is always true and the
// handler was never registered: nothing ever asked for those tiles and the
// edges stayed blank until a zoom happened to force a refresh.
//
// _update() is private API, but it is precisely what leaflet-rotate calls
// itself via _onMoveEnd. redraw() is the public alternative and is the wrong
// tool here: it drops every tile and re-adds them, so the map would blank and
// re-fade on every step of a rotation.
function refreshLayerTiles(layer) {
  if (!layer) return;
  if (typeof layer._update === 'function') {
    try {
      layer._update();
    } catch (e) {
      // A layer caught mid add/remove can throw here. Skipping it is correct;
      // it will get its tiles from the normal add path anyway.
    }
    return;
  }
  // Radar is a group of preloaded frame layers rather than a single grid,
  // so recurse instead of silently skipping it.
  if (typeof layer.eachLayer === 'function') layer.eachLayer(refreshLayerTiles);
}
// Throttled because heading lock drives setBearing from a requestAnimationFrame
// loop, so 'rotate' fires at display rate. L.Util.throttle fires on the leading
// edge and once more on the trailing edge, so the final resting bearing always
// gets a refresh rather than being left one frame stale. 200ms matches
// Leaflet's own updateInterval default.
map.on('rotate', L.Util.throttle(() => {
  for (const id in activeLeafletLayers) refreshLayerTiles(activeLeafletLayers[id]);
}, 200, null));

map.on('rotate', updateCompassDisplay);
updateCompassDisplay();

// ---------- Heading lock ----------
// Two states, toggled by the compass FAB:
//   locked   - map continuously rotates so the direction you're facing is
//              up. Free rotation is off (it would fight the sensor).
//   unlocked - map snaps back to north-up and stays where you put it;
//              drag/pinch-rotate work normally.
// Independent of navigation: navigating no longer force-rotates the map,
// it just respects whichever state this is in.
let headingLocked = false;
// Remembers the lock state from before navigation auto-enabled it, so
// stopping navigation restores the user's own choice instead of guessing.
let headingLockBeforeNav = null;

// map.setBearing is expensive - it rotates the map pane, fires Leaflet's
// 'rotate' event, and makes the vector renderer reproject every polyline
// (including both nav route lines). The compass sensor delivers at
// SENSOR_DELAY_GAME, roughly 50 readings a second, so calling it per
// reading meant ~50 full map re-renders per second. This gates on both a
// minimum angle change and a minimum interval, which cuts that to a
// handful per second with no visible loss of smoothness.
let programmaticMoveDepth = 0;
function programmaticMove(fn) {
  programmaticMoveDepth++;
  try { fn(); } finally {
    // Cleared on a timer, not immediately: Leaflet's move/zoom events are
    // asynchronous, so the events this call triggers arrive after the
    // synchronous call itself has already returned.
    setTimeout(() => { programmaticMoveDepth = Math.max(0, programmaticMoveDepth - 1); }, 400);
  }
}

// ---------- Heading-lock map rotation ----------
// The map's rotation is animated independently of the sensor rate rather
// than being driven directly by it. Driving it directly meant the map
// could only ever move in sensor-sized steps - and the throttle that used
// to guard this (a 1.5 degree deadband plus an 80ms gate) quantised those
// steps further, which is exactly what made rotation look choppy while
// the compass ribbon itself stayed smooth.
//
// Instead the sensor only ever updates a TARGET, and a requestAnimationFrame
// loop eases the map's actual bearing toward it at display rate. The loop
// stops as soon as it has caught up, so a stationary phone costs nothing -
// which was the real point of the old throttle, achieved without
// coarsening the motion.
const BEARING_EASE = 0.28;        // fraction of the remaining angle per frame
const BEARING_SETTLED_DEG = 0.05; // close enough to snap and stop the loop
const BEARING_MIN_FRAME_MS = 16;  // cap at ~60fps; rAF alone would run at 120Hz on a high-refresh screen
// Set only for the duration of each setBearing call. Deliberately NOT
// programmaticMove: that schedules a 400ms timer per call, which at 60fps
// would mean sixty timers created every second. leaflet-rotate fires
// 'rotate' synchronously from setBearing, so a plain flag is both cheaper
// and more precise.
let applyingBearingAnimation = false;
let targetBearing = null;
let renderedBearing = null;
let bearingRafId = null;
let lastBearingFrameAt = 0;

function applyHeadingLockBearing() {
  if (!headingLocked || !map.setBearing) return;
  // Negated deliberately. leaflet-rotate's setBearing applies a CSS
  // rotate(+bearing) to the map pane, so a geographic direction lands on
  // screen at `direction + bearing`. To bring the direction you're facing
  // to the top of the screen you need bearing = -heading. Negation is a
  // no-op at 0 and 180 degrees, so getting this wrong presents as "north
  // and south are fine but east and west are swapped" - which is exactly
  // how it surfaced in testing.
  targetBearing = -currentHeadingDeg;
  if (bearingRafId === null) bearingRafId = requestAnimationFrame(stepBearingAnimation);
}

// Applies a bearing while marking it as app-driven, so the follow-me
// gesture detector doesn't mistake our own rotation for the user
// twisting the map.
function applyBearingFrame(bearing) {
  applyingBearingAnimation = true;
  try { map.setBearing(bearing); } finally { applyingBearingAnimation = false; }
}

function stepBearingAnimation(now) {
  bearingRafId = null;
  if (!headingLocked || targetBearing === null) { renderedBearing = null; return; }

  // Frame cap. Re-schedule without doing any work, so the easing stays
  // time-based rather than silently running faster on a 120Hz panel.
  if (now - lastBearingFrameAt < BEARING_MIN_FRAME_MS) {
    bearingRafId = requestAnimationFrame(stepBearingAnimation);
    return;
  }
  lastBearingFrameAt = now;

  if (renderedBearing === null) renderedBearing = targetBearing;
  let delta = targetBearing - renderedBearing;
  delta = ((delta + 180) % 360 + 360) % 360 - 180; // shortest way round, so 359->1 doesn't spin backwards

  if (Math.abs(delta) < BEARING_SETTLED_DEG) {
    renderedBearing = targetBearing;
    applyBearingFrame(renderedBearing);
    return; // caught up - stop until the next sensor reading wakes it
  }
  renderedBearing += delta * BEARING_EASE;
  applyBearingFrame(renderedBearing);
  bearingRafId = requestAnimationFrame(stepBearingAnimation);
}

function setHeadingLock(on) {
  headingLocked = on;
  document.getElementById('btn-compass').classList.toggle('active', on);
  // Free rotation and the sensor can't both drive the bearing - whichever
  // moved last would win, which reads as the map fighting your finger.
  if (map.touchRotate) { on ? map.touchRotate.disable() : map.touchRotate.enable(); }
  if (on) {
    // Start from wherever the map currently sits so engaging the lock
    // eases into place rather than snapping.
    renderedBearing = map.getBearing ? map.getBearing() : 0;
    applyHeadingLockBearing();
    logInfo('Map locked to your heading.');
  } else if (map.setBearing) {
    programmaticMove(() => map.setBearing(0));
    logInfo('Map reset to north-up - drag or two-finger twist to rotate freely.');
  }
}

document.getElementById('btn-compass').onclick = () => setHeadingLock(!headingLocked);

// ---------- GPS / live position with real-time heading arrow ----------
let myMarker = null;
let followMe = true;

const headingArrowIcon = L.divIcon({
  className: '',
  html: `<div style="
    width: 0; height: 0;
    border-left: 9px solid transparent;
    border-right: 9px solid transparent;
    border-bottom: 20px solid #4c8bf5;
    filter: drop-shadow(0 0 2px rgba(0,0,0,0.6));
  "></div>`,
  iconSize: [18, 20],
  iconAnchor: [9, 14]
});

// currentHeadingRaw is straight off the sensor; currentHeadingDeg is what
// everything else uses, and is the raw value plus any manual north
// calibration offset. Keeping both means calibrating again later works
// off the true sensor reading rather than compounding on itself.
let compassNorthOffset = parseFloat(localStorage.getItem('compassNorthOffset') || '0') || 0;
let currentHeadingRaw = 0;
let currentHeadingDeg = 0;

function setRawHeading(raw) {
  currentHeadingRaw = ((raw % 360) + 360) % 360;
  currentHeadingDeg = ((currentHeadingRaw + compassNorthOffset) % 360 + 360) % 360;
}

function applyHeadingToMarker() {
  if (!myMarker || !myMarker.setRotation) return;
  // No map-bearing compensation here, deliberately. From leaflet-rotate's
  // _setPos: the marker's on-screen angle is `rotation + map._bearing`
  // when rotateWithView is set. A geographic direction lands on screen at
  // `direction + bearing` for the same reason, so passing the raw heading
  // is exactly what makes the arrow point the true way you're facing at
  // any map bearing - the plugin's own addition IS the compensation.
  // (An earlier version subtracted the bearing here, which double-
  // corrected and made the arrow wrong in nav mode.)
  myMarker.setRotation(currentHeadingDeg * Math.PI / 180);
}

// ---------- Compass ribbon (top-center, driven by the real device
// compass sensor - NOT map bearing/rotation, which is a separate concept
// covered by the round needle button instead) ----------
const COMPASS_RIBBON_PX_PER_DEG = 3;
const COMPASS_POINTS_45 = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const COMPASS_CARDINALS = new Set([0, 90, 180, 270]);
const COMPASS_POINTS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compassRibbonTrack = document.getElementById('compass-ribbon-track');
// Five full laps (-2..+2) of ticks built once up front, so the strip has
// plenty of room to slide through a couple of full device rotations
// before ever running off the edge of what's actually been built.
for (let lap = -2; lap <= 2; lap++) {
  for (let deg = 0; deg < 360; deg += 15) {
    const x = (lap * 360 + deg) * COMPASS_RIBBON_PX_PER_DEG;
    const isMajor = deg % 45 === 0;
    const tick = document.createElement('div');
    tick.className = 'compass-tick' + (isMajor ? ' major' : '');
    tick.style.left = `${x}px`;
    compassRibbonTrack.appendChild(tick);
    if (isMajor) {
      const label = document.createElement('div');
      label.className = 'compass-tick-label'
        + (COMPASS_CARDINALS.has(deg) ? ' cardinal' : '')
        + (deg === 0 ? ' north' : '');
      label.textContent = COMPASS_POINTS_45[deg];
      label.style.left = `${x}px`;
      compassRibbonTrack.appendChild(label);
    }
  }
}
// Same "continuously increasing/decreasing, never re-clamped to 0-360"
// trick used for the round needle button - the raw sensor heading can
// jump 359->0 in one real reading, and without unwrapping that the
// ribbon would visibly snap sideways once per rotation instead of
// sliding smoothly through it.
let continuousRibbonHeading = null; // null until the first real reading, so it starts aligned instead of snapping in from 0
// Declared here (not down with the rest of the navigation module's state,
// where it conceptually belongs) because updateCompassNavDiamond() reads
// it, and that gets called from updateCompassRibbon() - which can run
// synchronously at load time if the compass was already on from a
// previous session, well before the navigation module further down the
// file has executed its own declarations. A `let` read before its
// declaration line has run throws instead of just being undefined, and
// since that happened at the top level it silently killed every line of
// setup after it - GPS never started, the compass toggle never got wired,
// nothing crashed loudly enough to make that obvious without the log.
// navigatingRoute is declared here too, not down with the rest of the
// navigation state - redrawAllDataFromStore() (called synchronously at
// load) checks it inside a routes.forEach, and while there's an await
// before that point which likely makes the timing safe on its own, that's
// exactly the kind of subtle-timing argument that already produced one
// real crash in this file. Cheaper to just declare it early and remove
// the question entirely.
let navigatingRoute = null;
let navTargetBearing = null;

// While navigating, the map's heading-up rotation prefers GPS course-
// over-ground once you're actually moving, and falls back to the raw
// compass heading otherwise (including before any movement has been
// tracked yet, and again the moment you stop). GPS course is immune to
// magnetic interference and more reliable during real travel, but it's
// meaningless noise from position jitter below real walking pace or
// without a valid heading reading - hence the speed gate. This only
// affects which direction the MAP rotates to; the GPS marker's own arrow
// keeps showing the phone's actual physical facing regardless (see
// applyHeadingToMarker) - so if the two ever disagree while moving,
// that's a real, informative signal, not a bug.
function updateCompassRibbon() {
  if (continuousRibbonHeading === null) {
    continuousRibbonHeading = currentHeadingDeg;
  } else {
    let delta = currentHeadingDeg - (((continuousRibbonHeading % 360) + 360) % 360);
    delta = ((delta + 180) % 360 + 360) % 360 - 180;
    continuousRibbonHeading += delta;
  }
  // Wrap back into a single lap. The tick pattern repeats exactly every
  // 360 degrees, so subtracting a whole lap shifts the strip by exactly
  // one full period and renders identically - which means rotations are
  // unlimited in either direction. Without this the accumulator grew
  // without bound and eventually walked the strip clean off the end of
  // the pre-built ticks, leaving the ribbon blank (the failure seen after
  // the phone had been tumbling in a pocket while backgrounded).
  continuousRibbonHeading = ((continuousRibbonHeading % 360) + 360) % 360;

  const ribbon = document.getElementById('compass-ribbon');
  const headingX = continuousRibbonHeading * COMPASS_RIBBON_PX_PER_DEG;
  // clientWidth is 0 while the ribbon is display:none, which would park
  // the track half a ribbon-width out of position.
  const width = ribbon.clientWidth;
  if (width > 0) compassRibbonTrack.style.transform = `translateX(${width / 2 - headingX}px)`;

  const whole = Math.round(currentHeadingDeg) % 360;
  const point = COMPASS_POINTS_16[Math.round(currentHeadingDeg / 22.5) % 16];
  document.getElementById('compass-heading-readout').textContent =
    `${String(whole).padStart(3, '0')}\u00B0 ${point}`;

  // Reposition the nav diamond here too, not just from navigationTick -
  // heading updates far more often than GPS fixes do, and the diamond
  // needs to track the ribbon's own motion smoothly rather than jumping
  // once a second.
  updateCompassNavDiamond();
}

// Coming back from the background, re-anchor instead of animating through
// however far the heading moved while nothing was watching.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    continuousRibbonHeading = null;
    updateCompassRibbon();
  }
});

// Accuracy circle - only shown when the fix is poor (above threshold),
// since a precise-looking dot is misleading when GPS accuracy is actually
// tens of meters wide (common indoors, in canyons, under tree cover).
// Single source of truth for "this fix is weak": above it the dot goes
// amber AND the accuracy circle is drawn on the map, so the two always
// agree rather than being two independent thresholds.
const GPS_WEAK_ACCURACY_M = 20;
let accuracyCircle = null;

function updateAccuracyCircle(pos) {
  if (typeof pos.accuracy !== 'number' || pos.accuracy <= GPS_WEAK_ACCURACY_M) {
    if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
    return;
  }
  if (!accuracyCircle) {
    accuracyCircle = L.circle([pos.lat, pos.lng], {
      radius: pos.accuracy,
      color: '#4c8bf5', weight: 1, fillColor: '#4c8bf5', fillOpacity: 0.12
    }).addTo(map);
  } else {
    accuracyCircle.setLatLng([pos.lat, pos.lng]);
    accuracyCircle.setRadius(pos.accuracy);
  }
}

// Non-blocking - startListening is async now (it has to check whether
// the native sensor is really available before it can say so), but the
// rest of this module's setup shouldn't wait on that, so this isn't
// awaited at the top level; sensorMode just starts null and gets filled
// in a moment later. The GPS callback below reads it live via closure,
// not a snapshot, so this resolving slightly after GPS.startWatching()
// starts is harmless.
let sensorMode = null;
Compass.startListening(
  (headingDeg) => {
    setRawHeading(headingDeg);
    applyHeadingToMarker();
    updateCompassRibbon();
    applyHeadingLockBearing();
  },
  (accuracy) => updateCompassAccuracyBadge(accuracy)
).then((mode) => {
  sensorMode = mode;
  logInfo(mode ? `Compass sensor active (${mode}).` : 'No compass sensor available - heading will only update from GPS movement.');
});

// Only ever called from the native plugin (the web fallback has no
// equivalent accuracy signal) - a passive indicator on the ribbon plus a
// line in the calibration popover, so it costs nothing when confident.
let compassAccuracyLow = false;
function updateCompassAccuracyBadge(accuracy) {
  compassAccuracyLow = accuracy === 'low' || accuracy === 'unreliable';
  document.getElementById('compass-calibrate-warn').classList.toggle('hidden', !compassAccuracyLow);
  document.getElementById('compass-popover-warning').classList.toggle('hidden', !compassAccuracyLow);
}

// ---------- Popovers ----------
// Opened by their trigger, closed by tapping that trigger again or
// anywhere outside the panel. Triggers carry data-popover-trigger so the
// document-level close handler can tell "tapped the trigger" (which the
// trigger's own handler is already toggling) from "tapped away".
// Declared here, above closeAllPopovers, and NOT down with the rest of the
// GPS popover code. applyCompassRibbonVisibility() runs synchronously during
// load and calls closeAllPopovers(), which stops this ticker, so a `let`
// declared further down the file would still be in its temporal dead zone at
// that moment: a ReferenceError thrown from load-time code kills every
// remaining line of app init, silently.
let gpsPopoverTicker = null;
function stopGpsPopoverTicker() {
  if (gpsPopoverTicker === null) return;
  clearInterval(gpsPopoverTicker);
  gpsPopoverTicker = null;
}

function closeAllPopovers() {
  document.querySelectorAll('.popover').forEach((p) => p.classList.add('hidden'));
  // Single chokepoint: togglePopover, the tap-away handler and the compass
  // ribbon toggle all route through here, so the ticker cannot outlive a
  // hidden popover regardless of how it got closed.
  stopGpsPopoverTicker();
}
function togglePopover(id, onOpen) {
  const el = document.getElementById(id);
  const wasOpen = !el.classList.contains('hidden');
  closeAllPopovers();
  if (!wasOpen) {
    if (onOpen) onOpen();
    el.classList.remove('hidden');
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.popover') || e.target.closest('[data-popover-trigger]')) return;
  closeAllPopovers();
});

document.getElementById('compass-ribbon').onclick = () => togglePopover('popover-compass', renderNorthOffsetStatus);

// Off by default - toggled from Settings ("Show compass").
let showCompassRibbon = localStorage.getItem('showCompassRibbon') === 'true';
function applyCompassRibbonVisibility() {
  document.getElementById('compass-ribbon').classList.toggle('hidden', !showCompassRibbon);
  // Drives --top-row-h, which is what keeps the flag/route/record pills
  // clear of the ribbon (and lets them reclaim the space when it's off).
  document.body.classList.toggle('compass-on', showCompassRibbon);
  if (showCompassRibbon) {
    continuousRibbonHeading = null; // width is only measurable once it's visible
    updateCompassRibbon();
  } else {
    closeAllPopovers();
  }
}
applyCompassRibbonVisibility();
const showCompassToggle = document.getElementById('toggle-show-compass');
showCompassToggle.checked = showCompassRibbon;
showCompassToggle.addEventListener('change', () => {
  showCompassRibbon = showCompassToggle.checked;
  localStorage.setItem('showCompassRibbon', showCompassRibbon ? 'true' : 'false');
  applyCompassRibbonVisibility();
});

// ---------- Manual north calibration (in the compass ribbon's popover) ----------
// Corrects only which direction the app calls north; the heading itself
// still comes live from the sensors, so this is an offset, not a freeze.
function renderNorthOffsetStatus() {
  const el = document.getElementById('north-offset-status');
  if (!el) return;
  el.textContent = compassNorthOffset === 0
    ? 'North calibration: using the sensor\'s own north.'
    : `North calibration: shifted ${Math.round(compassNorthOffset)}\u00B0 from the sensor's north.`;
}
renderNorthOffsetStatus();

function refreshHeadingAfterCalibration() {
  setRawHeading(currentHeadingRaw);
  continuousRibbonHeading = null; // snap cleanly to the corrected heading instead of animating the whole offset
  applyHeadingToMarker();
  updateCompassRibbon();
  renderNorthOffsetStatus();
}

document.getElementById('btn-set-north').onclick = () => {
  compassNorthOffset = ((-currentHeadingRaw % 360) + 360) % 360;
  localStorage.setItem('compassNorthOffset', String(compassNorthOffset));
  refreshHeadingAfterCalibration();
  logInfo(`North calibrated - sensor heading ${Math.round(currentHeadingRaw)}\u00B0 is now shown as 0\u00B0.`);
};

document.getElementById('btn-reset-north').onclick = () => {
  compassNorthOffset = 0;
  localStorage.removeItem('compassNorthOffset');
  refreshHeadingAfterCalibration();
  logInfo('North calibration reset to the sensor\'s own north.');
};

// ---------- GPS status indicator ----------
// The chip is just a dot: green/amber/red for "can I trust this fix".
// The numbers behind that judgement live in the popover.
const gpsState = { status: 'searching', accuracy: null, lat: null, lng: null, altitude: null, at: null, error: null };

function gpsQuality() {
  // "searching" covers no-fix-yet and waiting-on-a-resync - both mean the
  // device is actively working on it, which reads as a spinner rather
  // than a colour. Red is therefore reserved for an actual failure
  // (permission denied, no location provider), so it always means
  // something is wrong - never just that the fix is loose.
  if (gpsState.status === 'searching' || gpsState.status === 'resyncing') return 'searching';
  if (gpsState.status !== 'locked') return 'poor';
  if (typeof gpsState.accuracy !== 'number') return 'good';
  return gpsState.accuracy <= GPS_WEAK_ACCURACY_M ? 'good' : 'fair';
}

function updateGpsIndicator() {
  const quality = gpsQuality();
  const searching = quality === 'searching';
  const dot = document.getElementById('gps-dot');
  document.getElementById('gps-spinner').classList.toggle('hidden', !searching);
  // Set className wholesale only when the dot is actually shown, so the
  // colour class can't fight the hidden class.
  dot.className = searching ? 'gps-dot hidden' : `gps-dot ${quality}`;
}

function renderGpsPopover() {
  const statusText = gpsState.status === 'error' ? gpsState.error
    : gpsState.status === 'searching' ? 'Searching for signal'
    : gpsState.status === 'resyncing' ? 'Resyncing'
    : 'Locked';
  document.getElementById('gps-popover-status').textContent = statusText;
  document.getElementById('gps-popover-accuracy').textContent =
    typeof gpsState.accuracy === 'number'
      ? `\u00B1${GPS.formatDistance(gpsState.accuracy / 1609.344, useMetric)}`
      : '\u2014';
  document.getElementById('gps-popover-coords').textContent =
    gpsState.lat != null ? `${gpsState.lat.toFixed(5)}, ${gpsState.lng.toFixed(5)}` : '\u2014';
  // GPS altitude is referenced to the WGS84 ellipsoid, not true sea level -
  // it can be off from a topo map's elevation by tens of metres depending
  // on location (the gap between the ellipsoid and the geoid). Labelling
  // it plainly as GPS elevation rather than implying it's corrected.
  document.getElementById('gps-popover-elevation').textContent =
    GPS.formatElevation(gpsState.altitude, useMetric);
  document.getElementById('gps-popover-age').textContent =
    gpsState.at ? `${Math.max(0, Math.round((Date.now() - gpsState.at) / 1000))}s ago` : '\u2014';
}

function isGpsPopoverOpen() {
  return !document.getElementById('popover-gps').classList.contains('hidden');
}

// Re-renders only when the popover is actually on screen. Every field in it
// was previously frozen at whatever it held when the popover was opened,
// because renderGpsPopover() ran on open and nowhere else: the position
// callback repainted the coloured dot but never the panel. Status was the
// visible symptom (a resync sat on "Resyncing" until the popover was closed
// and reopened, which made the fixed watch lifecycle look broken) but
// accuracy, coordinates, elevation and age were equally stale.
function refreshGpsPopoverIfOpen() {
  if (isGpsPopoverOpen()) renderGpsPopover();
}

// Age counts up from the last fix, so it changes with the clock rather than
// with incoming positions. Rendering it only on new fixes would freeze it
// exactly when GPS drops out, which is the one moment the number matters.
// gpsPopoverTicker and stopGpsPopoverTicker live up with closeAllPopovers;
// see the note there for why they cannot be declared here.
function startGpsPopoverTicker() {
  if (gpsPopoverTicker !== null) return;
  gpsPopoverTicker = setInterval(refreshGpsPopoverIfOpen, 1000);
}

document.getElementById('status-chip').onclick = () => {
  togglePopover('popover-gps', renderGpsPopover);
  // Checked after the toggle, since togglePopover decides which way it went.
  // A timer left running behind a hidden popover would be a wakeup a second
  // for nothing, on a device expected to sit in a pocket all day.
  if (isGpsPopoverOpen()) startGpsPopoverTicker();
  else stopGpsPopoverTicker();
};

// The status flip and indicator update stay synchronous so the UI reacts to
// the tap immediately; only the watch teardown/restart is awaited.
async function resyncGps() {
  gpsState.status = 'resyncing';
  updateGpsIndicator();
  await GPS.resync();
  logInfo('GPS resynced.');
}

document.getElementById('btn-gps-resync').onclick = async () => {
  await resyncGps();
  renderGpsPopover();
};

GPS.startWatching((pos) => {
  if (pos.error) {
    gpsState.status = 'error';
    gpsState.error = pos.error;
    updateGpsIndicator();
    refreshGpsPopoverIfOpen();
    logError(`GPS error: ${pos.error}`);
    return;
  }
  gpsState.status = 'locked';
  gpsState.error = null;
  gpsState.accuracy = typeof pos.accuracy === 'number' ? pos.accuracy : null;
  gpsState.lat = pos.lat;
  gpsState.lng = pos.lng;
  gpsState.altitude = typeof pos.altitude === 'number' ? pos.altitude : null;
  gpsState.at = Date.now();
  updateGpsIndicator();
  refreshGpsPopoverIfOpen();

  if (!sensorMode && typeof pos.heading === 'number' && !isNaN(pos.heading)) {
    setRawHeading(pos.heading); // fallback path also honours north calibration
    updateCompassRibbon();
    applyHeadingLockBearing();
  }
  Compass.updateLocation(pos.lat, pos.lng, pos.altitude); // no-op on the web fallback; feeds the native plugin's true-north correction

  if (!myMarker) {
    myMarker = L.marker([pos.lat, pos.lng], { icon: headingArrowIcon, rotation: 0, rotateWithView: true }).addTo(map);
    myMarker.on('click', async (ev) => {
      // In flag/route mode the tap is meant for the map, not for the
      // marker - drop the flag / add the point right where they tapped.
      if (flagModeActive || planningRoute) handleMapTap(ev.latlng);
      else await resyncGps();
    });
    applyHeadingToMarker();
    logInfo(`First GPS fix received: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`);
  } else {
    myMarker.setLatLng([pos.lat, pos.lng]);
  }
  updateAccuracyCircle(pos);

  if (!hasCenteredOnFirstFix) {
    hasCenteredOnFirstFix = true;
    programmaticMove(() => map.setView([pos.lat, pos.lng], 14));
  } else if (followMe) {
    programmaticMove(() => map.panTo([pos.lat, pos.lng]));
  }

  if (recording) recordPoint(pos); // fully independent of navigation below - both just read the same fix
  if (navigatingRoute) navigationTick(pos);
  else checkNavSuggestion(pos);
});

document.getElementById('btn-locate').onclick = async () => {
  followMe = true;
  if (myMarker) programmaticMove(() => map.panTo(myMarker.getLatLng()));
  else logError('No GPS fix yet - check location permission is granted.');
  await resyncGps(); // recentre and ask the location provider for a fresh fix
};
// Any user-initiated map gesture stops follow-me, not just a drag.
// Pinch-zoom and two-finger rotate previously left followMe set, so the
// next GPS fix silently panned the map back - which is the "it jumps to a
// different position after a while" behaviour.
//
// The complication is that Leaflet fires the same events for the app's own
// programmatic moves (recentring, locate, search, navigation), so those
// have to be marked or they'd immediately switch follow-me off themselves.
// A counter rather than a boolean, so overlapping programmatic moves
// can't have the inner one clear the flag while the outer is still going.
// Detect a genuine user gesture by whether a finger is actually on the
// map, rather than by which Leaflet event fired. Two reasons:
//   1. leaflet-rotate's two-finger pinch/rotate handlers call _moveStart
//      and _move directly, so they emit 'movestart' but never 'dragstart'
//      or 'zoomstart' - which is how pinching and twisting still left
//      follow-me on, and the map still jumped back on the next GPS fix.
//   2. Telling programmatic moves apart by a timer is inherently racy.
//      A pointer on the map container is not: the app's own recentring,
//      search and navigation moves never have one, and the FAB stack and
//      other controls sit outside the map element so their taps don't
//      count either.
let lastMapPointerAt = 0;
['pointerdown', 'touchstart', 'mousedown'].forEach((ev) => {
  map.getContainer().addEventListener(ev, () => { lastMapPointerAt = Date.now(); }, true);
});
map.on('movestart dragstart zoomstart rotate', () => {
  // Generous window: a gesture's move events can trail its initial touch
  // by a moment, and the cost of being slightly too eager here is only
  // that follow-me switches off - which is what the user was asking for
  // by touching the map anyway.
  // Both conditions: a recent touch on the map AND not inside one of the
  // app's own moves. Either alone would be enough in almost every case;
  // together they cover the overlap (a programmatic recentre landing
  // moments after the user happened to tap the map).
  // Our own heading-lock rotation must never be read as a user gesture -
  // without this, tapping the map and then rotating within the two-second
  // window would silently switch follow-me off.
  if (applyingBearingAnimation) return;
  if (programmaticMoveDepth === 0 && Date.now() - lastMapPointerAt < 2000) followMe = false;
});

// ---------- Universal place search (top bar) ----------
document.getElementById('btn-search').onclick = runTopSearch;
document.getElementById('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runTopSearch();
});

async function runTopSearch() {
  const query = document.getElementById('search-input').value;
  if (!query.trim()) return;
  const resultsBox = document.getElementById('search-results');
  resultsBox.innerHTML = '<div class="result-item">Searching…</div>';
  resultsBox.classList.remove('hidden');
  try {
    const results = await Geocode.search(query);
    if (!results.length) { resultsBox.innerHTML = '<div class="result-item">No results found.</div>'; return; }
    resultsBox.innerHTML = '';
    results.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'result-item';
      item.textContent = r.label;
      item.onclick = () => { programmaticMove(() => map.setView([r.lat, r.lng], 13)); resultsBox.classList.add('hidden'); };
      resultsBox.appendChild(item);
    });
  } catch (e) {
    logError(`Search failed: ${e.message}`);
    resultsBox.innerHTML = '<div class="result-item">Search failed - check connection.</div>';
  }
}

// ---------- Flags: tap-to-place with auto-numbering, selectable icons, undo/redo ----------
let flagModeActive = false;
const flagMarkers = new Map();
const DEFAULT_NAME_RE = /^Flag (\d+)$/;
let currentFlagIconType = 'flag';
let flagUndoStack = []; // { type: 'add'|'delete', wp }
let flagRedoStack = [];

function nextDefaultFlagNumber(existingWaypoints) {
  const used = existingWaypoints.map(w => (DEFAULT_NAME_RE.exec(w.name) || [])[1]).filter(Boolean).map(Number);
  return used.length ? Math.max(...used) + 1 : 1;
}

function flagTypeById(id) {
  return FLAG_TYPES.find(t => t.id === id) || FLAG_TYPES[0];
}

function buildFlagDivIcon(iconType, bound) {
  const type = flagTypeById(iconType);
  // Bound flags get the route's color as a ring instead of the default
  // dark border - the same shared amber every route already renders in.
  const border = bound ? '3px solid #ffb703' : '2px solid #171d26';
  return L.divIcon({
    className: '',
    html: `<div style="
      width: 30px; height: 30px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
      background: ${type.color}; border: ${border}; box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
    "><div style="transform: rotate(45deg); width: 16px; height: 16px; color: #fff;">${ICONS[type.icon]}</div></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30]
  });
}

function renderIconPicker(container, selectedId, onSelect) {
  container.innerHTML = '';
  FLAG_TYPES.forEach((type) => {
    const btn = document.createElement('button');
    btn.className = 'icon-picker-btn' + (type.id === selectedId ? ' selected' : '');
    btn.title = type.label;
    btn.style.color = type.color;
    btn.innerHTML = ICONS[type.icon];
    btn.onclick = () => onSelect(type.id);
    container.appendChild(btn);
  });
}

// Icon picker for NEW flags (shown in the flag-mode status pill)
function refreshNewFlagIconPicker() {
  renderIconPicker(document.getElementById('flag-type-picker'), currentFlagIconType, (id) => {
    currentFlagIconType = id;
    document.getElementById('btn-flag-icon-toggle').textContent = `Icon: ${flagTypeById(id).label}`;
    refreshNewFlagIconPicker();
  });
}
refreshNewFlagIconPicker();
document.getElementById('btn-flag-icon-toggle').onclick = () => {
  document.getElementById('flag-type-picker').classList.toggle('hidden');
  refreshControlLayout();
};

// ---------- Control pill layout ----------
// The flag and route menus anchor vertically to the FAB that opened them,
// so each pops out beside its own icon rather than at a fixed spot. Done
// by measurement rather than CSS because the FAB stack's height changes
// with its contents, so there's no static offset that stays correct.
function positionControlPill(pillId, anchorId) {
  const pill = document.getElementById(pillId);
  const anchor = document.getElementById(anchorId);
  if (!pill || !anchor || pill.classList.contains('hidden')) return;
  const anchorRect = anchor.getBoundingClientRect();
  // A collapsed FAB menu leaves its buttons with no layout box - fall back
  // to the CSS default rather than pinning the pill to the top-left.
  if (anchorRect.height === 0) { pill.style.bottom = ''; return; }
  const centreFromBottom = window.innerHeight - anchorRect.bottom + anchorRect.height / 2;
  pill.style.bottom = `${Math.max(8, centreFromBottom - pill.offsetHeight / 2)}px`;
}

// The pills and the legends live on opposite sides, but a wide pill (the
// route menu with all its buttons, or the flag menu with its icon grid
// open) can still reach across into the legend column - so this tests
// actual rectangle intersection instead of assuming they can't collide,
// and lifts the legend stack only when they really do overlap.
// The legend stack must never be pushed above this - losing the legend
// off the top of the screen is worse than it being partly covered.
const LEGEND_MIN_TOP_PX = 150;

function updateLegendClearance() {
  const stack = document.getElementById('map-overlays-stack');
  if (!stack) return;

  // The stack has `transition: bottom 0.2s ease` (so a lift settles
  // smoothly rather than snapping). That's exactly what corrupted this
  // measurement: clearing style.bottom and immediately calling
  // getBoundingClientRect() in the same synchronous tick could read a
  // position still mid-animation from whatever the PREVIOUS lift was,
  // not the settled CSS value - meaning every distance computed from
  // that point was wrong. Disabling the transition for the measurement
  // step (and restoring it before the final value is applied) is the
  // standard fix: the write-then-immediately-read only needs to be
  // instantaneous, not the eventual animation to the result.
  stack.style.transition = 'none';
  stack.style.bottom = ''; // back to the CSS rule's value, so "natural" below is genuinely unlifted
  stack.offsetHeight; // force a synchronous layout flush before reading anything
  const naturalBottom = window.innerHeight - stack.getBoundingClientRect().bottom;

  if (stack.getBoundingClientRect().height === 0) { stack.style.transition = ''; return; }

  // Everything that can share the bottom band. The route picker is
  // measured rather than given a fixed CSS offset like the nav HUD,
  // because its height changes with how many routes are listed.
  const ids = ['flag-status-pill', 'route-status-pill', 'dialog-nav-route-picker', 'nav-suggest'];

  let finalBottom = naturalBottom;
  // Iterative: raising the stack clear of one panel can move it into
  // another, so re-measure after each lift instead of computing a single
  // offset from the original position. Three passes is plenty for the
  // four elements involved and guarantees termination.
  for (let pass = 0; pass < 3; pass++) {
    stack.style.bottom = `${finalBottom}px`;
    const sr = stack.getBoundingClientRect();
    let needed = null;
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('hidden')) continue;
      const r = el.getBoundingClientRect();
      const overlaps = r.left < sr.right && r.right > sr.left
        && r.top < sr.bottom && r.bottom > sr.top;
      if (overlaps) needed = Math.max(needed ?? 0, sr.bottom - r.top + 8);
    }
    if (needed === null) break; // clear of everything at this position

    // The ceiling is whichever is LARGER: the natural (unlifted) position,
    // or however far the top-of-screen limit allows. Taking the larger of
    // the two - not the top-of-screen limit alone - is what actually
    // matters here: a legend tall enough that the top-clamp computes to
    // less than its own default position must fall back to that default,
    // not get pushed BELOW it. Clamping to a value smaller than natural
    // was the second bug - it could move a tall legend further down than
    // doing nothing at all, which read as "disappeared" behind whatever
    // it was already overlapping.
    const topClampBottom = Math.max(0, window.innerHeight - sr.height - LEGEND_MIN_TOP_PX);
    const ceiling = Math.max(naturalBottom, topClampBottom);
    finalBottom = Math.min(finalBottom + needed, ceiling);
    if (finalBottom >= ceiling) break; // clamped - accept partial overlap rather than making it worse
  }

  stack.style.bottom = `${finalBottom}px`;
  // Restore the transition on the next frame, after this final value has
  // already been painted once - re-enabling it in the same tick as the
  // last write can make THAT write itself animate from stale state too.
  requestAnimationFrame(() => { stack.style.transition = ''; });
}

// Single entry point - always reposition before measuring for overlap,
// since the pill's own position determines whether it overlaps at all.
function refreshControlLayout() {
  positionControlPill('flag-status-pill', 'btn-waypoint');
  positionControlPill('route-status-pill', 'btn-route');
  updateLegendClearance();
}
window.addEventListener('resize', refreshControlLayout);

function setFlagMode(on) {
  flagModeActive = on;
  document.getElementById('btn-waypoint').classList.toggle('active', on);
  document.getElementById('flag-status-pill').classList.toggle('hidden', !on);
  if (!on) document.getElementById('flag-type-picker').classList.add('hidden');
  refreshControlLayout();
  if (on && planningRoute) cancelRoutePlanning();
  updateZoomLock();
  logInfo(on ? 'Flag mode ON - tap the map to drop flags.' : 'Flag mode off.');
}
document.getElementById('btn-waypoint').onclick = () => setFlagMode(!flagModeActive);

function updateFlagUndoRedoButtons() {
  document.getElementById('btn-undo-flag').classList.toggle('disabled', flagUndoStack.length === 0);
  document.getElementById('btn-redo-flag').classList.toggle('disabled', flagRedoStack.length === 0);
}
updateFlagUndoRedoButtons();

document.getElementById('btn-undo-flag').onclick = async () => {
  const action = flagUndoStack.pop();
  if (!action) return;
  try {
    if (action.type === 'add') {
      await Store.deleteWaypoint(action.wp.id);
      const marker = flagMarkers.get(action.wp.id);
      if (marker) { map.removeLayer(marker); flagMarkers.delete(action.wp.id); }
      await renumberDefaultFlags();
    } else {
      await Store.saveWaypoint(action.wp);
      drawWaypointMarker(action.wp);
      await renumberDefaultFlags();
    }
    flagRedoStack.push(action);
    updateFlagUndoRedoButtons();
    logInfo('Flag action undone.');
  } catch (e) {
    logError(`Failed to undo flag action: ${e.message}`);
  }
};

document.getElementById('btn-redo-flag').onclick = async () => {
  const action = flagRedoStack.pop();
  if (!action) return;
  try {
    if (action.type === 'add') {
      await Store.saveWaypoint(action.wp);
      drawWaypointMarker(action.wp);
      await renumberDefaultFlags();
    } else {
      await Store.deleteWaypoint(action.wp.id);
      const marker = flagMarkers.get(action.wp.id);
      if (marker) { map.removeLayer(marker); flagMarkers.delete(action.wp.id); }
      await renumberDefaultFlags();
    }
    flagUndoStack.push(action);
    updateFlagUndoRedoButtons();
    logInfo('Flag action redone.');
  } catch (e) {
    logError(`Failed to redo flag action: ${e.message}`);
  }
};

function drawWaypointMarker(wp) {
  const marker = L.marker([wp.lat, wp.lng], { icon: buildFlagDivIcon(wp.iconType, !!wp.boundRouteId) }).addTo(map);
  marker.bindTooltip(wp.name, { permanent: false });
  marker.on('click', () => {
    if (planningRoute) {
      addRoutePoint({ lat: wp.lat, lng: wp.lng }, wp.id);
      logInfo(`Route point ${routePoints.length} added from flag "${wp.name}".`);
      return;
    }
    openEditFlagDialog(wp, marker);
  });
  flagMarkers.set(wp.id, marker);
  return marker;
}

let editingFlag = null;
let editingFlagIconType = 'flag';


async function openEditFlagDialog(wp, marker) {
  editingFlag = { wp, marker };
  editingFlagIconType = wp.iconType || 'flag';
  document.getElementById('wp-name').value = wp.name;
  document.getElementById('wp-notes').value = wp.notes || '';
  refreshEditFlagIconPicker();
  await refreshFlagBindSection();
  openDialog('dialog-waypoint');
}

// Shared by the manual Bind button and auto-bind-on-drop below - which
// routes (if any) is a point close enough to bind to, closest first.
// Bind hit testing happens in SCREEN space, against what amounts to an
// invisible thickened copy of each route. This mirrors the 22 px hitLine that
// already makes routes tappable, so "close enough to bind" and "close enough
// to tap" are the same target, and both stay constant at every zoom.
//
// The previous approach converted a pixel radius into a world distance and
// then clamped it to sane metres. That clamp is what broke zoomed out: at
// zoom 8 a 200 m cap works out to 0.4 px, so a flag dropped squarely on the
// visible line was nowhere near binding. Measuring in pixels removes the
// conversion, the clamp, and the latitude and rotation corrections along with
// it, since containerPoint already accounts for all of them.
//
// Matching the hitLine weight: half of 22 px is the perpendicular distance
// from the centreline to the edge of that stroke, so this binds exactly when
// the tap lands on the drawn hit area.
const BIND_PROXIMITY_PX = 11;
// Two routes count as "too close to call" when their pixel distances are
// within this of each other, rather than a fixed world distance which would
// mean something different at every zoom.
const BIND_TIE_PX = 4;

// Perpendicular pixel distance from p to segment ab, all in container points.
function pointToSegmentPx(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  // Degenerate segment (both ends on the same pixel) reduces to point distance.
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

// Closest approach of a route to a point, in screen pixels.
function routeDistancePx(point, routePoints) {
  if (!routePoints || routePoints.length < 2) return Infinity;
  const p = map.latLngToContainerPoint(point);
  let best = Infinity;
  let prev = map.latLngToContainerPoint(routePoints[0]);
  for (let i = 1; i < routePoints.length; i++) {
    const cur = map.latLngToContainerPoint(routePoints[i]);
    const d = pointToSegmentPx(p, prev, cur);
    if (d < best) best = d;
    prev = cur;
  }
  return best;
}

async function findBindCandidates(point) {
  const routes = await Store.getRoutes();
  return routes
    // The world-space projection is still what gets stored: it supplies the
    // snapped position and the distance along the route. Only the decision of
    // whether a route is a candidate at all is made in screen space.
    .map(r => ({ route: r, proj: GPS.projectOntoRoute(point, r.points), px: routeDistancePx(point, r.points) }))
    .filter(c => c.proj && c.px <= BIND_PROXIMITY_PX)
    .sort((a, b) => a.px - b.px);
}

async function refreshFlagBindSection() {
  const wp = editingFlag.wp;
  const section = document.getElementById('wp-bind-section');
  const statusEl = document.getElementById('wp-bind-status');
  const bindBtn = document.getElementById('btn-bind-flag');
  const unbindBtn = document.getElementById('btn-unbind-flag');
  section.classList.remove('hidden');
  // Setting display directly rather than toggling a class - guarantees
  // exactly one of these can ever be visible, with no dependency on CSS
  // specificity/cascade order elsewhere in the stylesheet.
  // Toggled by class, not by inline style. Both buttons ship with `hidden` in
  // the markup, and `.hidden { display: none }`, so the previous
  // `style.display = ''` never revealed them: clearing an inline declaration
  // does not set a value, it hands control back to the cascade, where
  // `.hidden` still won. Both buttons were therefore invisible in every
  // state, which meant unbinding a flag was impossible and manual binding
  // had never worked at all.
  bindBtn.classList.add('hidden');
  unbindBtn.classList.add('hidden');

  if (wp.boundRouteId) {
    const routes = await Store.getRoutes();
    const route = routes.find(r => r.id === wp.boundRouteId);
    statusEl.textContent = route ? `Bound to route "${route.name}".` : 'Bound to a route.';
    unbindBtn.classList.remove('hidden');
    return;
  }

  const candidates = await findBindCandidates(wp);
  if (!candidates.length) {
    statusEl.textContent = 'Not bound to a route.';
    return;
  }
  statusEl.textContent = candidates.length === 1
    ? `Close to route "${candidates[0].route.name}".`
    : 'Close to more than one route.';
  bindBtn.classList.remove('hidden');
  bindBtn.onclick = () => bindFlagToRoute(candidates);
}

async function bindFlagToRoute(candidates, reopenDialogAfterTie = true) {
  let chosen = candidates[0];
  // Only ambiguous if the two closest are within the tie threshold of
  // each other - otherwise the closest one is an obvious enough choice
  // that asking would just be friction.
  if (candidates.length > 1 && (candidates[1].px - candidates[0].px) <= BIND_TIE_PX) {
    const pick = await askRouteChoice(candidates.map(c => c.route));
    // askRouteChoice opens its own dialog, which (like every overlay)
    // hides whatever else was open. Only reopen the flag dialog if this
    // was called from there in the first place (the manual Bind button) -
    // auto-bind-on-drop calls this with reopenDialogAfterTie=false, since
    // forcing the edit dialog open after a plain drop would be a jarring,
    // unrequested side effect.
    if (reopenDialogAfterTie) openDialog('dialog-waypoint');
    if (!pick) return;
    chosen = candidates.find(c => c.route.id === pick.id);
  }
  const wp = editingFlag.wp;
  try {
    wp.lat = chosen.proj.projected.lat;
    wp.lng = chosen.proj.projected.lng;
    wp.boundRouteId = chosen.route.id;
    wp.routeDistance = chosen.proj.distanceAlongRouteMiles;
    await Store.saveWaypoint(wp);
    editingFlag.marker.setLatLng([wp.lat, wp.lng]);
    // wp.iconType, not the module-level editingFlagIconType - that
    // reflects whatever flag was last open in the edit dialog, which is
    // wrong (and possibly stale) when this is called from a fresh drop
    // instead of from editing this specific flag.
    editingFlag.marker.setIcon(buildFlagDivIcon(wp.iconType, true));
    logInfo(`Flag "${wp.name}" bound to route "${chosen.route.name}".`);
  } catch (e) {
    logError(`Failed to bind flag: ${e.message}`);
  }
  // Only refresh the bind-section UI if the flag dialog is actually open -
  // skip it entirely when this was called from a fresh drop, where there's
  // no dialog showing at all to update.
  if (!document.getElementById('dialog-waypoint').classList.contains('hidden')) {
    await refreshFlagBindSection();
  }
}

document.getElementById('btn-unbind-flag').onclick = async () => {
  const wp = editingFlag.wp;
  try {
    wp.boundRouteId = null;
    wp.routeDistance = null;
    await Store.saveWaypoint(wp);
    // wp.iconType, not the module-level editingFlagIconType, for the same
    // reason spelled out in bindFlagToRoute. Unbind does not commit an
    // unsaved icon choice, so trusting the picker's live value would leave
    // the marker showing an icon that does not match what was just persisted.
    editingFlag.marker.setIcon(buildFlagDivIcon(wp.iconType, false));
    logInfo(`Flag "${wp.name}" unbound from its route.`);
  } catch (e) {
    logError(`Failed to unbind flag: ${e.message}`);
  }
  await refreshFlagBindSection();
};

// Generic "pick one of these routes" prompt - only needed for the near-tie
// binding case above, but written generically in case something else
// wants a route picker later.
function askRouteChoice(routes) {
  return new Promise((resolve) => {
    const list = document.getElementById('route-choice-list');
    list.innerHTML = '';
    routes.forEach((r) => {
      const btn = document.createElement('button');
      btn.className = 'btn-secondary full-width';
      btn.style.marginBottom = '8px';
      btn.textContent = r.name;
      btn.onclick = () => { closeOverlay('dialog-route-choice'); resolve(r); };
      list.appendChild(btn);
    });
    document.getElementById('btn-route-choice-cancel').onclick = () => { closeOverlay('dialog-route-choice'); resolve(null); };
    openDialog('dialog-route-choice');
    // Backdrop tap means no route picked, same as Cancel.
    dialogDismissHandlers.set('dialog-route-choice', () => { closeOverlay('dialog-route-choice'); resolve(null); });
  });
}

function refreshEditFlagIconPicker() {
  renderIconPicker(document.getElementById('wp-icon-picker'), editingFlagIconType, (id) => {
    editingFlagIconType = id;
    refreshEditFlagIconPicker();
  });
}

document.getElementById('btn-save-waypoint').onclick = async () => {
  if (!editingFlag) return;
  const newName = document.getElementById('wp-name').value.trim() || editingFlag.wp.name;
  const newNotes = document.getElementById('wp-notes').value;
  // Reject a name another flag already has. Checked here rather than in
  // dataStore so the dialog can stay open with the text still in the
  // field, instead of silently discarding what was typed.
  const allWaypoints = await Store.getWaypoints();
  const clash = allWaypoints.some(w => w.id !== editingFlag.wp.id
    && (w.name || '').trim().toLowerCase() === newName.trim().toLowerCase());
  if (clash) {
    await showAlert('Name already used', `Another flag is already called "${newName}". Pick a different name.`);
    openDialog('dialog-waypoint'); // showAlert's dialog closed this one
    return;
  }
  try {
    // Mutate in place, don't spread into a new object - the marker's click
    // handler closed over this exact wp reference when it was drawn, and
    // only sees future changes if this same object is updated, not a copy.
    // A new object here is what left the rename dialog showing the name
    // from whenever the marker was last drawn, not the last save.
    Object.assign(editingFlag.wp, { name: newName, notes: newNotes, iconType: editingFlagIconType });
    await Store.saveWaypoint(editingFlag.wp);
    editingFlag.marker.setTooltipContent(newName);
    editingFlag.marker.setIcon(buildFlagDivIcon(editingFlagIconType, !!editingFlag.wp.boundRouteId));
    logInfo(`Flag "${newName}" saved.`);
  } catch (e) {
    logError(`Failed to save flag: ${e.message}`);
  }
  closeOverlay('dialog-waypoint');
  editingFlag = null;
};

document.getElementById('btn-delete-waypoint').onclick = async () => {
  if (!editingFlag) return;
  const { wp, marker } = editingFlag;
  try {
    await Store.deleteWaypoint(wp.id);
    map.removeLayer(marker);
    flagMarkers.delete(wp.id);
    flagUndoStack.push({ type: 'delete', wp });
    flagRedoStack = [];
    updateFlagUndoRedoButtons();
    logInfo(`Flag "${wp.name}" deleted.`);
    await renumberDefaultFlags();
  } catch (e) {
    logError(`Failed to delete flag: ${e.message}`);
  }
  closeOverlay('dialog-waypoint');
  editingFlag = null;
};

async function renumberDefaultFlags() {
  const all = await Store.getWaypoints();
  const defaultOnes = all.filter(w => DEFAULT_NAME_RE.test(w.name)).sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < defaultOnes.length; i++) {
    const desiredName = `Flag ${i + 1}`;
    if (defaultOnes[i].name !== desiredName) {
      const updated = { ...defaultOnes[i], name: desiredName };
      await Store.saveWaypoint(updated);
      const marker = flagMarkers.get(updated.id);
      if (marker) marker.setTooltipContent(desiredName);
    }
  }
}

// ---------- Unified data layer redraw ----------
let sessionOverlayLines = [];
// Keyed by route id, populated fresh on every redraw - lets the proximity
// flow animation below find "the visible line for route X" without
// having to re-derive it, since sessionOverlayLines is just a flat list
// of every layer with no way to tell which route each one belongs to.
let routeVisibleLineById = new Map();

function clearAllDataLayers() {
  flagMarkers.forEach(m => map.removeLayer(m));
  flagMarkers.clear();
  sessionOverlayLines.forEach(l => map.removeLayer(l));
  sessionOverlayLines = [];
  routeVisibleLineById = new Map();
}

async function redrawAllDataFromStore() {
  clearAllDataLayers();
  try {
    const [waypoints, routes, tracks] = await Promise.all([Store.getWaypoints(), Store.getRoutes(), Store.getTracks()]);
    waypoints.forEach(drawWaypointMarker);
    routes.forEach((r) => {
      // The actively-navigated route draws its own split traveled/remaining
      // lines (see navigationTick) instead of this static rendering - skip
      // it here so the two don't draw on top of each other.
      if (navigatingRoute && navigatingRoute.id === r.id) return;
      let dist = 0;
      for (let i = 1; i < r.points.length; i++) dist += GPS.distanceMiles(r.points[i - 1], r.points[i]);
      const latlngs = r.points.map(p => [p.lat, p.lng]);
      // The "More" button opens the route details sheet (rename/delete/
      // per-segment distance list). It's plain HTML inside a Leaflet popup,
      // so it has no live handler until the popup actually opens - wired
      // below via the popupopen event on each layer, which is the standard
      // way to attach behavior to interactive popup content in Leaflet.
      const popupHtml = `<b>${r.name}</b><br>${GPS.formatDistance(dist, useMetric)}<br><button type="button" class="pill-btn route-popup-more">More</button> <button type="button" class="pill-btn route-popup-trim">Trim</button> <button type="button" class="pill-btn pill-btn-danger route-popup-delete">Delete</button>`;
      // A visible thin line plus an invisible wide one underneath sharing
      // the same popup - the thin line matches the line's real weight
      // visually, but taps register over a much wider margin around it
      // (Leaflet's hit-test area otherwise matches the visual line weight
      // almost exactly, which is what made these hard to tap).
      const hitLine = L.polyline(latlngs, { color: '#000', weight: 22, opacity: 0 }).bindPopup(popupHtml);
      const visibleLine = L.polyline(latlngs, { color: '#ffb703', weight: 3, dashArray: '6,6' }).bindPopup(popupHtml);
      // Must be attached to BOTH polylines. The popup can be opened from
      // either the wide invisible hit line or the thin visible one, and each
      // carries its own popup instance, so wiring only one leaves the buttons
      // dead depending on exactly where the tap landed.
      const wireRoutePopupButtons = (layer) => {
        layer.on('popupopen', (e) => {
          const el = e.popup.getElement();
          if (!el) return;
          const moreBtn = el.querySelector('.route-popup-more');
          if (moreBtn) moreBtn.onclick = () => { map.closePopup(); openRouteDetailsSheet(r); };
          const trimBtn = el.querySelector('.route-popup-trim');
          // Popup closed first: the trim dialog draws a preview on the map and
          // refits the view, which an open popup would sit on top of.
          if (trimBtn) trimBtn.onclick = () => { map.closePopup(); openTrimRouteDialog(r); };
          const delBtn = el.querySelector('.route-popup-delete');
          if (delBtn) delBtn.onclick = async () => {
            // Popup closed before the prompt so a Leaflet popup and a modal
            // dialog are never both on screen competing for the tap.
            map.closePopup();
            const ok = await askConfirm('Delete route?', `Delete saved route "${r.name}"?`);
            if (!ok) return;
            await unbindFlagsFromRoute(r.id);
            await Store.deleteRoute(r.id);
            if (nearbyRouteForSuggestion && nearbyRouteForSuggestion.route.id === r.id) hideNavSuggestion();
            logInfo(`Route "${r.name}" deleted.`);
            await redrawAllDataFromStore();
            renderDataPanel();
          };
        });
      };
      wireRoutePopupButtons(hitLine);
      wireRoutePopupButtons(visibleLine);
      hitLine.addTo(map);
      visibleLine.addTo(map);
      sessionOverlayLines.push(hitLine, visibleLine);
      routeVisibleLineById.set(r.id, visibleLine);
    });
    tracks.forEach((t) => {
      let dist = 0;
      for (let i = 1; i < t.points.length; i++) dist += GPS.distanceMiles(t.points[i - 1], t.points[i]);
      const latlngs = t.points.map(p => [p.lat, p.lng]);
      const popupHtml = `<b>${t.name}</b><br>${GPS.formatDistance(dist, useMetric)}`
        + `<br><button type="button" class="pill-btn track-popup-more">More</button> `
        + `<button type="button" class="pill-btn track-popup-trim">Trim</button> `
        + `<button type="button" class="pill-btn pill-btn-danger track-popup-delete">Delete</button>`;
      const hitLine = L.polyline(latlngs, { color: '#000', weight: 22, opacity: 0 }).bindPopup(popupHtml);
      const visibleLine = L.polyline(latlngs, { color: '#e6484f', weight: 3 }).bindPopup(popupHtml);

      // Both the visible line and the wide invisible hit line carry their own
      // popup instance, so wiring only one leaves the buttons dead depending
      // on exactly where the tap landed. Same reason as the route version.
      const wireTrackPopupButtons = (layer) => {
        layer.on('popupopen', (e) => {
          const el = e.popup.getElement();
          if (!el) return;
          const moreBtn = el.querySelector('.track-popup-more');
          if (moreBtn) moreBtn.onclick = () => { map.closePopup(); openRouteDetailsSheet(t, 'track'); };
          const trimBtn = el.querySelector('.track-popup-trim');
          if (trimBtn) trimBtn.onclick = () => { map.closePopup(); openTrimRouteDialog(t, 'track'); };
          const delBtn = el.querySelector('.track-popup-delete');
          if (delBtn) delBtn.onclick = async () => {
            map.closePopup();
            const ok = await askConfirm('Delete track?', `Delete recorded track "${t.name}"? This can't be undone.`);
            if (!ok) return;
            await Store.deleteTrack(t.id);
            logInfo(`Track "${t.name}" deleted.`);
            await redrawAllDataFromStore();
            renderDataPanel();
          };
        });
      };
      wireTrackPopupButtons(hitLine);
      wireTrackPopupButtons(visibleLine);

      hitLine.addTo(map);
      visibleLine.addTo(map);
      sessionOverlayLines.push(hitLine, visibleLine);
    });
    logInfo(`Loaded ${waypoints.length} flag(s), ${routes.length} route(s), ${tracks.length} track(s).`);
  } catch (e) {
    logError(`Failed to load saved data: ${e.message}`);
  }
}
redrawAllDataFromStore();

// ---------- Route details sheet (opened via "More" on a route's map popup) ----------
let routeDetailsContext = null;
// Which store the open details sheet belongs to, so rename and delete write
// back to the right one.
let routeDetailsKind = 'route'; // the full route object currently shown in the sheet

// kind is 'route' or 'track'. Held on the context so the rename and delete
// handlers write back to the right store.
function openRouteDetailsSheet(route, kind = 'route') {
  routeDetailsContext = route;
  routeDetailsKind = kind;
  renderRouteDetailsSheet(route);
  openOverlay('sheet-route-details');
}

function renderRouteDetailsSheet(route) {
  const isTrack = routeDetailsKind === 'track';
  document.getElementById('route-details-name').textContent = route.name;
  const segmentsList = document.getElementById('route-details-segments');
  segmentsList.innerHTML = '';

  let total = 0;
  for (let i = 1; i < route.points.length; i++) total += GPS.distanceMiles(route.points[i - 1], route.points[i]);

  // Navigation follows a planned route. Offering it for a recorded track would
  // mean navigating a path already walked, point by point, which is not what
  // the feature does.
  document.getElementById('btn-route-details-navigate').classList.toggle('hidden', isTrack);

  // A plotted route has a handful of deliberate points, so listing each
  // segment is useful. A recorded track has one every few seconds, so the same
  // list would be thousands of rows of a few metres each: slow to build and
  // telling the user nothing. Tracks get a summary instead.
  document.getElementById('route-details-segments-title').textContent = isTrack ? 'Recording' : 'Segments';
  if (isTrack) {
    const rows = [];
    if (route.startedAt) rows.push(['Started', new Date(route.startedAt).toLocaleString()]);
    if (route.endedAt) rows.push(['Finished', new Date(route.endedAt).toLocaleString()]);
    if (route.startedAt && route.endedAt) {
      const mins = Math.max(0, Math.round((route.endedAt - route.startedAt) / 60000));
      rows.push(['Duration', `${Math.floor(mins / 60)}h ${mins % 60}m`]);
      if (mins > 0) rows.push(['Average pace', `${GPS.formatDistance(total / (mins / 60), useMetric)} per hour`]);
    }
    const withEle = route.points.filter(p => typeof p.altitude === 'number');
    if (withEle.length > 1) {
      let gain = 0;
      for (let i = 1; i < withEle.length; i++) {
        const d = withEle[i].altitude - withEle[i - 1].altitude;
        // Only rises count toward gain, and a small threshold keeps GPS
        // altitude noise from accumulating into a fictional climb.
        if (d > 1) gain += d;
      }
      rows.push(['Elevation gain', GPS.formatElevation(gain, useMetric)]);
    }
    rows.push(['Points recorded', String(route.points.length)]);
    for (const [label, value] of rows) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${label}<br><small>${value}</small></span>`;
      segmentsList.appendChild(li);
    }
  } else {
    for (let i = 1; i < route.points.length; i++) {
      const segDist = GPS.distanceMiles(route.points[i - 1], route.points[i]);
      const li = document.createElement('li');
      li.innerHTML = `<span>Point ${i} &rarr; Point ${i + 1}<br><small>${GPS.formatDistance(segDist, useMetric)}</small></span>`;
      segmentsList.appendChild(li);
    }
  }

  document.getElementById('route-details-total').textContent =
    `Total: ${GPS.formatDistance(total, useMetric)} across ${route.points.length} points`;
}

document.getElementById('btn-route-details-rename').onclick = async () => {
  if (!routeDetailsContext) return;
  // askName/askConfirm open their own overlay, which hides this sheet -
  // reopen it afterward either way (with fresh data on success, unchanged
  // on cancel) since openOverlay doesn't restore whatever was open before it.
  const newName = await askName(routeDetailsKind === 'track' ? 'Rename track' : 'Rename route', routeDetailsContext.name);
  if (newName === null) { openOverlay('sheet-route-details'); return; }
  try {
    const updated = { ...routeDetailsContext, name: newName };
    if (routeDetailsKind === 'track') await Store.saveTrack(updated);
    else await Store.saveRoute(updated);
    routeDetailsContext = updated;
    logInfo(`${routeDetailsKind === 'track' ? 'Track' : 'Route'} renamed to "${newName}".`);
    await redrawAllDataFromStore();
    renderRouteDetailsSheet(updated);
    openOverlay('sheet-route-details');
  } catch (e) {
    logError(`Failed to rename route: ${e.message}`);
    openOverlay('sheet-route-details');
  }
};

// A flag shouldn't vanish just because the route it was bound to did -
// this clears the binding and leaves the flag exactly where it is.
async function unbindFlagsFromRoute(routeId) {
  const waypoints = await Store.getWaypoints();
  for (const wp of waypoints.filter(w => w.boundRouteId === routeId)) {
    wp.boundRouteId = null;
    wp.routeDistance = null;
    await Store.saveWaypoint(wp);
  }
}

document.getElementById('btn-route-details-delete').onclick = async () => {
  if (!routeDetailsContext) return;
  const route = routeDetailsContext;
  const isTrack = routeDetailsKind === 'track';
  const ok = await askConfirm(isTrack ? 'Delete track?' : 'Delete route?',
    isTrack ? `Delete recorded track "${route.name}"? This can't be undone.` : `Delete saved route "${route.name}"?`);
  if (!ok) { openOverlay('sheet-route-details'); return; }
  try {
    if (isTrack) {
      await Store.deleteTrack(route.id);
    } else {
      // Flags bind to routes only, and a navigation suggestion can only point
      // at a route, so neither applies to a track.
      await unbindFlagsFromRoute(route.id);
      await Store.deleteRoute(route.id);
      if (nearbyRouteForSuggestion && nearbyRouteForSuggestion.route.id === route.id) hideNavSuggestion();
    }
    logInfo(`${isTrack ? 'Track' : 'Route'} "${route.name}" deleted.`);
    routeDetailsContext = null;
    await redrawAllDataFromStore();
    renderDataPanel();
  } catch (e) {
    logError(`Failed to delete route: ${e.message}`);
  }
  closeOverlay('sheet-route-details');
};

// ---------- Route navigation ----------
// Fully independent of track recording (both just read the GPS callback,
// see the "if (navigatingRoute) navigationTick(pos);" line there) and of
// route planning (can't be entered while planningRoute is true anyway,
// since Start only appears in a saved route's own detail sheet).
const NAV_START_PROXIMITY_MILES = 50 / 1609.344;
const NAV_ARRIVAL_MILES = 15 / 1609.344;
const NAV_WAYPOINT_REACHED_MILES = 15 / 1609.344;
const NAV_OFF_ROUTE_WARN_MILES = 30 / 1609.344;

let navBoundFlagsSorted = []; // bound flags on this route, ascending by routeDistance
let navNextWaypointIndex = 0; // index into navBoundFlagsSorted - only ever advances
let navTraveledLine = null, navRemainingLine = null;

// A single-button variant of the existing Yes/No confirm dialog, reused
// here rather than building a whole new modal type just for "waypoint
// reached" / "you've arrived" notifications.
function showAlert(title, message) {
  return new Promise((resolve) => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const yesBtn = document.getElementById('btn-confirm-yes');
    const noBtn = document.getElementById('btn-confirm-no');
    yesBtn.textContent = 'OK';
    noBtn.classList.add('hidden');
    openDialog('dialog-confirm');
    // No restore step: askConfirm() sets both buttons explicitly when it
    // opens, so it no longer depends on this cleanup putting them back.
    const cleanup = () => {
      yesBtn.onclick = null;
      closeOverlay('dialog-confirm');
    };
    yesBtn.onclick = () => { cleanup(); resolve(); };
    // An alert has only one outcome, so a backdrop tap is the same as OK.
    dialogDismissHandlers.set('dialog-confirm', () => { cleanup(); resolve(); });
  });
}

// Shared by both the manual "Start navigation" button in the route
// details sheet and the automatic proximity suggestion below - the
// proximity gate itself lives in whichever caller needs to decide what to
// tell the user if they're too far (the button shows an alert; the
// automatic path just doesn't offer the button in the first place).
async function startNavigatingRoute(route, proj) {
  navigatingRoute = route;
  const waypoints = await Store.getWaypoints();
  navBoundFlagsSorted = waypoints
    .filter(w => w.boundRouteId === route.id)
    .sort((a, b) => a.routeDistance - b.routeDistance);
  navNextWaypointIndex = navBoundFlagsSorted.findIndex(w => w.routeDistance >= proj.distanceAlongRouteMiles);
  if (navNextWaypointIndex === -1) navNextWaypointIndex = navBoundFlagsSorted.length; // already past every bound flag

  hideNavSuggestion();
  document.getElementById('nav-hud').classList.remove('hidden');
  document.body.classList.add('nav-hud-active'); // lifts the legend stack clear of the HUD
  refreshControlLayout();
  programmaticMove(() => map.setView([gpsState.lat, gpsState.lng], 17));
  followMe = true; // starting navigation re-engages follow, even if a drag had turned it off earlier
  // Heading lock defaults ON when navigation starts - following a route is
  // exactly the case where heading-up is what you want. Whatever the lock
  // was set to beforehand is remembered and restored on stop, so this
  // doesn't quietly overwrite a deliberate preference for browsing
  // north-up; it just doesn't make you set it every single time.
  headingLockBeforeNav = headingLocked;
  if (!headingLocked) setHeadingLock(true);
  await redrawAllDataFromStore(); // hides the route's normal render now that navigatingRoute is set
  navigationTick({ lat: gpsState.lat, lng: gpsState.lng });
  logInfo(`Navigating "${route.name}".`);
}

document.getElementById('btn-route-details-navigate').onclick = async () => {
  if (!routeDetailsContext) return;
  const route = routeDetailsContext;
  if (gpsState.lat == null) { logError('No GPS fix yet - can\'t check your distance to the route.'); return; }

  const proj = GPS.projectOntoRoute({ lat: gpsState.lat, lng: gpsState.lng }, route.points);
  if (!proj || proj.offRouteMiles > NAV_START_PROXIMITY_MILES) {
    await showAlert('Too far from the route', `Get within ${GPS.formatDistance(NAV_START_PROXIMITY_MILES, useMetric)} of "${route.name}" to start navigating it.`);
    return;
  }
  closeOverlay('sheet-route-details');
  await startNavigatingRoute(route, proj);
};

// ---------- Automatic "you're near a route" suggestion ----------
// No taps needed to discover this: every GPS tick (see the main callback
// below) checks proximity to every saved route whenever nothing's
// currently being navigated, and surfaces a one-tap Start button the
// moment you're close enough to actually start - same proximity rule
// startNavigatingRoute itself uses, so if the button appears, tapping it
// always works.
let nearbyRouteForSuggestion = null; // {route, proj} or null
let flowingRouteId = null; // whichever route currently has the animation applied, so it can be cleared when proximity moves elsewhere

function setFlowingRoute(routeId) {
  if (flowingRouteId === routeId) return;
  if (flowingRouteId) routeVisibleLineById.get(flowingRouteId)?.getElement()?.classList.remove('route-line-flowing');
  flowingRouteId = routeId;
  if (routeId) routeVisibleLineById.get(routeId)?.getElement()?.classList.add('route-line-flowing');
}

function hideNavSuggestion() {
  nearbyRouteForSuggestion = null;
  nearbyRoutes = [];
  clearPreviewRoute(); // otherwise a previewed route keeps animating after walking out of range
  document.getElementById('dialog-nav-route-picker').classList.add('hidden');
  document.getElementById('nav-suggest').classList.add('hidden');
  setFlowingRoute(null);
  refreshControlLayout(); // the bar just vanished - let the legends drop back down
}

// Every saved route currently within starting range, nearest first. The
// suggestion bar shows a direct Start for a single route, and opens the
// picker instead when several are in range - which is common where routes
// share a trailhead, and where silently picking "the closest" would be a
// coin flip between two paths going opposite directions.
let nearbyRoutes = [];

async function checkNavSuggestion(pos) {
  if (navigatingRoute || planningRoute || flagModeActive) { hideNavSuggestion(); return; }
  // Don't re-shuffle the list out from under the picker while it's open -
  // entries moving or renumbering mid-selection would be disorienting.
  if (!document.getElementById('dialog-nav-route-picker').classList.contains('hidden')) return;

  const routes = await Store.getRoutes();
  nearbyRoutes = routes
    .map(route => ({ route, proj: GPS.projectOntoRoute(pos, route.points) }))
    .filter(r => r.proj && r.proj.offRouteMiles <= NAV_START_PROXIMITY_MILES)
    .sort((a, b) => a.proj.offRouteMiles - b.proj.offRouteMiles);

  nearbyRouteForSuggestion = nearbyRoutes[0] || null;
  const suggestEl = document.getElementById('nav-suggest');
  // Track visibility across calls: this runs on every GPS fix, and only a
  // change in whether the bar is shown can affect the legend stack.
  const wasVisible = !suggestEl.classList.contains('hidden');
  if (!nearbyRoutes.length) {
    suggestEl.classList.add('hidden');
    setFlowingRoute(null);
    if (wasVisible) refreshControlLayout();
    return;
  }

  const multiple = nearbyRoutes.length > 1;
  document.getElementById('nav-suggest-label').textContent = multiple
    ? `${nearbyRoutes.length} routes nearby`
    : `Start navigating "${nearbyRoutes[0].route.name}"`;
  document.getElementById('btn-nav-suggest-start').textContent = multiple ? 'Choose' : 'Start';
  suggestEl.classList.remove('hidden');
  if (!wasVisible) requestAnimationFrame(refreshControlLayout); // bar just appeared - lift the legends clear of it
  // Only animate a single candidate - flowing every nearby route at once
  // would just be noise, and which one is "the" route is exactly the
  // question the picker exists to answer.
  setFlowingRoute(multiple ? null : nearbyRoutes[0].route.id);
}

document.getElementById('btn-nav-suggest-start').onclick = async () => {
  if (!nearbyRoutes.length) return;
  if (nearbyRoutes.length === 1) {
    const { route, proj } = nearbyRoutes[0];
    await startNavigatingRoute(route, proj);
    return;
  }
  openNavRoutePicker();
};

// ---------- Nearby-route picker ----------
// Previewing is deliberately non-committal: it restyles the line and moves
// the map, but changes no navigation state, so cycling through options
// costs nothing and Cancel genuinely undoes everything.
let previewRouteId = null;

// Preview marks the selected route with the flowing-dash animation
// (setFlowingRoute) rather than making it solid. Every route stays dashed
// throughout, so the only thing that distinguishes the selection is
// motion - which reads as "this is the live one" without the selected
// route changing shape or weight as you cycle through the list.
// Frames the whole route rather than just panning to the nearest point on
// it: zoom is derived from the route's own extent, so a short loop fills
// the screen and a long trail zooms out to fit - which is what makes
// cycling through the list actually comparable.
function fitMapToRoute(route) {
  if (!route.points || route.points.length < 2) return;
  const bounds = L.latLngBounds(route.points.map(p => [p.lat, p.lng]));
  // Asymmetric padding: the top bar covers the top of the map, and the
  // picker panel covers the bottom, so an evenly-padded fit would centre
  // the route behind them. The panel's height is measured rather than
  // assumed because it grows with the number of routes listed.
  const picker = document.getElementById('dialog-nav-route-picker');
  const pickerH = picker.classList.contains('hidden') ? 60 : picker.offsetHeight + 30;
  programmaticMove(() => map.fitBounds(bounds, {
    paddingTopLeft: [30, 120],
    paddingBottomRight: [30, pickerH],
    // Without a cap, a very short route zooms to maximum detail, which
    // loses all surrounding context and makes it hard to tell where the
    // route actually is relative to you.
    maxZoom: 16,
    animate: true
  }));
}

// Fades every route except the selected one, so the selection reads
// clearly however many other routes happen to be drawn nearby. Passing
// null restores them all to full opacity.
function applyPreviewDimming(selectedId) {
  routeVisibleLineById.forEach((line, id) => {
    line.setStyle({ opacity: selectedId && id !== selectedId ? 0.2 : 1 });
  });
}

// Applies the flowing-dash + pulsing-glow treatment to exactly one route.
// Toggled across every line rather than tracked incrementally, so
// switching selection can't leave the previous one still glowing.
function setSelectedRouteStyling(routeId) {
  routeVisibleLineById.forEach((line, id) => {
    const el = line.getElement();
    if (el) el.classList.toggle('route-line-selected', id === routeId);
  });
}

function setPreviewRoute(routeId) {
  previewRouteId = routeId;
  // The picker's own selected styling replaces the single-route flowing
  // hint - otherwise a route could carry both animations at once.
  setFlowingRoute(null);
  setSelectedRouteStyling(routeId);
  applyPreviewDimming(routeId);
  if (!routeId) return;
  const entry = nearbyRoutes.find(r => r.route.id === routeId);
  if (entry) fitMapToRoute(entry.route);
  renderNavRoutePickerList();
}

function clearPreviewRoute() {
  previewRouteId = null;
  setFlowingRoute(null);
  setSelectedRouteStyling(null);
  applyPreviewDimming(null);
}

function renderNavRoutePickerList() {
  const list = document.getElementById('nav-route-picker-list');
  list.innerHTML = '';
  nearbyRoutes.forEach(({ route, proj }) => {
    const li = document.createElement('li');
    li.className = route.id === previewRouteId ? 'selected' : '';
    li.innerHTML = `<span>${route.name}<br><small>${GPS.formatDistance(proj.offRouteMiles, useMetric)} away, ${GPS.formatDistance(proj.totalRouteMiles, useMetric)} long</small></span>`;
    li.onclick = () => setPreviewRoute(route.id);
    list.appendChild(li);
  });
}

// Shown/hidden directly rather than through openOverlay/closeOverlay:
// those add the dimming backdrop and force-hide every other overlay,
// both of which defeat the point here - the map needs to stay fully
// visible and undimmed while routes are being compared on it.
function setNavRoutePickerOpen(open) {
  document.getElementById('dialog-nav-route-picker').classList.toggle('hidden', !open);
  // Measured after the class change so the panel has (or has lost) its
  // layout box by the time the legend stack is checked against it.
  requestAnimationFrame(refreshControlLayout);
  // The suggestion bar sits in the same spot and says the same thing, so
  // it steps aside while the picker is up rather than stacking with it.
  document.getElementById('nav-suggest').classList.toggle('hidden', open || !nearbyRoutes.length);
}

function openNavRoutePicker() {
  setPreviewRoute(nearbyRoutes[0].route.id); // preview the nearest immediately, so the panel is never a dead list
  setNavRoutePickerOpen(true);
}

document.getElementById('btn-nav-picker-cancel').onclick = () => {
  clearPreviewRoute();
  setNavRoutePickerOpen(false);
};

document.getElementById('btn-nav-picker-confirm').onclick = async () => {
  const entry = nearbyRoutes.find(r => r.route.id === previewRouteId);
  clearPreviewRoute(); // startNavigatingRoute redraws anyway, but don't leave a preview style behind if it bails
  setNavRoutePickerOpen(false);
  if (entry) await startNavigatingRoute(entry.route, entry.proj);
};

async function stopNavigation(reason) {
  const route = navigatingRoute;
  navigatingRoute = null;
  navBoundFlagsSorted = [];
  navNextWaypointIndex = 0;
  navTargetBearing = null;
  if (navTraveledLine) { map.removeLayer(navTraveledLine); navTraveledLine = null; }
  if (navRemainingLine) { map.removeLayer(navRemainingLine); navRemainingLine = null; }
  document.getElementById('nav-hud').classList.add('hidden');
  document.body.classList.remove('nav-hud-active');
  refreshControlLayout();
  updateCompassNavDiamond();
  // Restore whatever the lock was before navigation turned it on, rather
  // than forcing either state - setHeadingLock(false) handles the actual
  // reset to north-up.
  if (headingLockBeforeNav !== null && headingLocked !== headingLockBeforeNav) setHeadingLock(headingLockBeforeNav);
  headingLockBeforeNav = null;
  await redrawAllDataFromStore(); // restores the route's normal render
  if (route) logInfo(`Navigation stopped${reason ? ` (${reason})` : ''}.`);
}
document.getElementById('btn-nav-stop').onclick = () => stopNavigation('stopped');

function navigationTick(pos) {
  if (!navigatingRoute) return;
  const proj = GPS.projectOntoRoute(pos, navigatingRoute.points);
  if (!proj) return;

  // Keep centred on the current position while navigating, but honour
  // follow-me: an earlier version recentred unconditionally so that a
  // stale drag from before navigation couldn't disable it, but that also
  // meant panning away mid-navigation to look at something got yanked
  // back a second later with no way to stop it. Starting navigation now
  // re-enables follow-me explicitly, which solves the stale-drag problem
  // without taking away the ability to pan.
  if (followMe) programmaticMove(() => map.panTo([pos.lat, pos.lng], { animate: true, duration: 0.3 }));

  // Split polyline: everything behind the projected point dims, ahead
  // stays the normal route color - the "eating away" effect. Created once
  // and then updated in place on every later tick: the previous version
  // removed and re-added both layers every GPS fix, which meant tearing
  // down and rebuilding two full SVG path elements once a second, and on
  // a long route that's enough main-thread work to visibly jank
  // everything else (including how promptly the position marker appears
  // to move). setLatLngs just rewrites the existing path's geometry.
  const points = navigatingRoute.points;
  const traveled = points.slice(0, proj.segmentIndex + 1).concat([proj.projected]).map(p => [p.lat, p.lng]);
  const remaining = [proj.projected].concat(points.slice(proj.segmentIndex + 1)).map(p => [p.lat, p.lng]);
  if (navTraveledLine) {
    navTraveledLine.setLatLngs(traveled);
  } else {
    navTraveledLine = L.polyline(traveled, { color: '#8a93a3', weight: 4, opacity: 0.7 }).addTo(map);
  }
  if (navRemainingLine) {
    navRemainingLine.setLatLngs(remaining);
  } else {
    navRemainingLine = L.polyline(remaining, { color: '#ffb703', weight: 4 }).addTo(map);
  }

  document.getElementById('nav-remaining').textContent = GPS.formatDistance(proj.remainingMiles, useMetric);

  const offRouteEl = document.getElementById('nav-off-route-warning');
  if (proj.offRouteMiles > NAV_OFF_ROUTE_WARN_MILES) {
    offRouteEl.textContent = `${GPS.formatDistance(proj.offRouteMiles, useMetric)} off route`;
    offRouteEl.classList.remove('hidden');
  } else {
    offRouteEl.classList.add('hidden');
  }

  // Advance past any bound flag close enough to count as reached - a while
  // loop (not if) in case GPS jumped far enough in one fix to pass more
  // than one at once. navNextWaypointIndex only ever increases, so an
  // already-announced flag can't trigger a second alert.
  while (
    navNextWaypointIndex < navBoundFlagsSorted.length &&
    proj.distanceAlongRouteMiles >= navBoundFlagsSorted[navNextWaypointIndex].routeDistance - NAV_WAYPOINT_REACHED_MILES
  ) {
    const reached = navBoundFlagsSorted[navNextWaypointIndex];
    navNextWaypointIndex++;
    showAlert('Waypoint reached', `You reached "${reached.name}".`);
  }

  const nextWaypoint = navBoundFlagsSorted[navNextWaypointIndex] || null;
  const nwBlock = document.getElementById('nav-next-waypoint-block');
  if (nextWaypoint) {
    nwBlock.classList.remove('hidden');
    document.getElementById('nav-next-waypoint').textContent =
      GPS.formatDistance(Math.max(0, nextWaypoint.routeDistance - proj.distanceAlongRouteMiles), useMetric);
    // GPS.bearingDegrees is pure lat/lng geometry, so it's inherently
    // true-north-referenced - but currentHeadingDeg (and therefore
    // continuousRibbonHeading, which updateCompassNavDiamond compares
    // this against) carries whatever manual north calibration the user
    // has set. Without applying the same offset here, the two values are
    // in different reference frames, and the diamond lands off by
    // whatever that offset is - which is exactly why it was in the wrong
    // spot on the ribbon.
    navTargetBearing = ((GPS.bearingDegrees(pos, nextWaypoint) + compassNorthOffset) % 360 + 360) % 360;
  } else {
    nwBlock.classList.add('hidden');
    navTargetBearing = null;
  }
  updateCompassNavDiamond();

  if (proj.remainingMiles <= NAV_ARRIVAL_MILES) {
    const name = navigatingRoute.name;
    stopNavigation('arrived').then(() => showAlert('Arrived', `You've reached the end of "${name}".`));
  }
}

// Positions the glowing diamond on the ribbon's sliding track at
// navTargetBearing - same coordinate space as the tick marks (degrees *
// COMPASS_RIBBON_PX_PER_DEG), but as one continuously-repositioned
// element rather than repeated across every lap, since it tracks a
// single live target rather than a fixed compass point.
function updateCompassNavDiamond() {
  const diamond = document.getElementById('compass-nav-diamond');
  if (navTargetBearing === null || continuousRibbonHeading === null) {
    diamond.classList.add('hidden');
    return;
  }
  diamond.classList.remove('hidden');
  // Shift the raw bearing to whichever 360-equivalent value sits closest
  // to the current (unwrapped, possibly-multi-lap) ribbon heading, so the
  // diamond sits at the correct relative offset from the fixed pointer
  // instead of jumping to a distant lap copy.
  let delta = navTargetBearing - (((continuousRibbonHeading % 360) + 360) % 360);
  delta = ((delta + 180) % 360 + 360) % 360 - 180;
  const trackPos = continuousRibbonHeading + delta;
  diamond.style.left = `${trackPos * COMPASS_RIBBON_PX_PER_DEG}px`;
}

// ---------- Route planning ----------
let planningRoute = false;
let routePoints = [];
let routeRedoStack = []; // points popped by Undo, restorable by Redo until a new point is added
// Parallel to routePoints - the flag id a point came from, or null for a
// plain map tap. Only used at save time, to auto-bind whichever flags
// were used to build the route (the "connect flags" method from the
// README - there's no separate code path for it, tapping a flag while
// planning just adds a point at that flag's location, so this is how
// those points get remembered as flag-origin rather than arbitrary taps).
let routePointFlagIds = [];
let routeLine = null;
let routeLineHitbox = null;
let editingRouteId = null;

function startRoutePlanning(prefillPoints = [], existingId = null) {
  if (flagModeActive) setFlagMode(false);
  planningRoute = true;
  editingRouteId = existingId;
  routePoints = [...prefillPoints];
  routeRedoStack = [];
  routePointFlagIds = prefillPoints.map(() => null); // re-editing a saved route doesn't know which points were flags
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (routeLineHitbox) { map.removeLayer(routeLineHitbox); routeLineHitbox = null; }
  if (routePoints.length) updateRouteLine();
  updateUndoRedoButtons();
  document.getElementById('route-status-pill').classList.remove('hidden');
  refreshControlLayout();
  document.getElementById('btn-route').classList.add('active');
  updateZoomLock();
  logInfo(existingId ? 'Editing saved route - tap the map or a flag to add points, Finish to re-save.' : 'Route planning started - tap the map or a flag to add points.');
}

function cancelRoutePlanning() {
  planningRoute = false;
  editingRouteId = null;
  routeRedoStack = [];
  routePointFlagIds = [];
  routePoints = []; // was previously only reset when STARTING a route, so a
                    // finished route's points lingered in memory afterwards
  document.getElementById('route-distance').textContent = GPS.formatDistance(0, useMetric);
  document.getElementById('btn-route').classList.remove('active');
  updateZoomLock();
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (routeLineHitbox) { map.removeLayer(routeLineHitbox); routeLineHitbox = null; }
  document.getElementById('route-status-pill').classList.add('hidden');
  refreshControlLayout();
}

// Tapping the route FAB while already in route mode now cancels it - the
// same as tapping the explicit Cancel button - instead of just re-starting
// a fresh empty route every time.
document.getElementById('btn-route').onclick = () => {
  if (planningRoute) cancelRoutePlanning();
  else startRoutePlanning();
};

function updateUndoRedoButtons() {
  document.getElementById('btn-undo-route').classList.toggle('disabled', routePoints.length === 0);
  document.getElementById('btn-redo-route').classList.toggle('disabled', routeRedoStack.length === 0);
}

function addRoutePoint(point, flagId = null) {
  routePoints.push(point);
  routePointFlagIds.push(flagId);
  routeRedoStack = []; // a fresh point invalidates any pending redo history
  updateRouteLine();
  updateUndoRedoButtons();
}

document.getElementById('btn-undo-route').onclick = () => {
  if (!routePoints.length) return;
  routeRedoStack.push({ point: routePoints.pop(), flagId: routePointFlagIds.pop() });
  updateRouteLine();
  updateUndoRedoButtons();
  logInfo(`Route point undone (${routePoints.length} remaining).`);
};
document.getElementById('btn-redo-route').onclick = () => {
  if (!routeRedoStack.length) return;
  const { point, flagId } = routeRedoStack.pop();
  routePoints.push(point);
  routePointFlagIds.push(flagId);
  updateRouteLine();
  updateUndoRedoButtons();
  logInfo(`Route point redone (${routePoints.length} total).`);
};

function updateRouteLine() {
  if (routeLine) map.removeLayer(routeLine);
  if (routeLineHitbox) map.removeLayer(routeLineHitbox);
  let dist = 0;
  for (let i = 1; i < routePoints.length; i++) dist += GPS.distanceMiles(routePoints[i - 1], routePoints[i]);
  const latlngs = routePoints.map(p => [p.lat, p.lng]);
  const popupHtml = GPS.formatDistance(dist, useMetric);
  routeLineHitbox = L.polyline(latlngs, { color: '#000', weight: 22, opacity: 0 }).bindPopup(popupHtml).addTo(map);
  routeLine = L.polyline(latlngs, { color: '#ffb703', weight: 4 }).bindPopup(popupHtml).addTo(map);
  document.getElementById('route-distance').textContent = GPS.formatDistance(dist, useMetric);
}

document.getElementById('btn-finish-route').onclick = async () => {
  if (routePoints.length < 2) { logError('Need at least 2 points to save a route - tap the map more before finishing.'); return; }
  const existingRoutes = await Store.getRoutes();
  const takenNames = existingRoutes.filter(r => r.id !== editingRouteId).map(r => r.name);
  const name = await askUniqueName('Name this route', 'My Route', takenNames, 'route');
  if (name === null) return;
  try {
    await Store.saveRoute({ id: editingRouteId, name, points: routePoints });
    logInfo(editingRouteId ? `Route "${name}" updated with ${routePoints.length} points.` : `Route "${name}" saved with ${routePoints.length} points.`);
    // Auto-bind: any point that came from tapping a flag (routePointFlagIds
    // tracks this) gets bound to the route just saved, with its exact
    // distance-along-route - no projection needed here, since the point
    // IS the route's own vertex at that index.
    const savedRoutes = await Store.getRoutes();
    const savedRoute = editingRouteId ? savedRoutes.find(r => r.id === editingRouteId) : savedRoutes[savedRoutes.length - 1];
    if (savedRoute) {
      for (let i = 0; i < routePointFlagIds.length; i++) {
        const flagId = routePointFlagIds[i];
        if (!flagId) continue;
        const waypoints = await Store.getWaypoints();
        const wp = waypoints.find(w => w.id === flagId);
        if (!wp) continue;
        wp.boundRouteId = savedRoute.id;
        wp.routeDistance = GPS.distanceAlongRouteToIndex(routePoints, i);
        await Store.saveWaypoint(wp);
      }
    }
    await redrawAllDataFromStore();
  } catch (e) {
    logError(`Failed to save route: ${e.message}`);
  }
  cancelRoutePlanning();
};
document.getElementById('btn-cancel-route').onclick = cancelRoutePlanning;

// ---------- Single shared map-click handler (flags + route points) ----------
// Extracted so the GPS position marker can route taps here too - a
// marker swallows the click rather than letting it reach the map, so in
// flag/route mode tapping your own position would otherwise do nothing.
async function handleMapTap(latlng) {
  const e = { latlng };
  if (planningRoute) {
    addRoutePoint({ lat: e.latlng.lat, lng: e.latlng.lng });
    logInfo(`Route point ${routePoints.length} added.`);
    return;
  }
  if (flagModeActive) {
    try {
      const existing = await Store.getWaypoints();
      const num = nextDefaultFlagNumber(existing);
      const wp = await Store.saveWaypoint({ lat: e.latlng.lat, lng: e.latlng.lng, name: `Flag ${num}`, notes: '', iconType: currentFlagIconType });
      const marker = drawWaypointMarker(wp);
      flagUndoStack.push({ type: 'add', wp });
      flagRedoStack = [];
      updateFlagUndoRedoButtons();
      logInfo(`Flag "${wp.name}" dropped.`);

      // Dropped directly on (or near) a route's own hit line - auto-bind
      // immediately rather than making the user open the flag and tap
      // Bind manually. Same candidate logic as the manual path (closest
      // route wins, tie-picker if two are nearly equidistant), just
      // triggered at drop time instead of from the edit dialog.
      const candidates = await findBindCandidates(wp);
      if (candidates.length) {
        editingFlag = { wp, marker }; // bindFlagToRoute needs this set, same as if the dialog had opened it
        await bindFlagToRoute(candidates, false);
        editingFlag = null;
        // Auto-bind used to leave no trace outside the debug log, so a flag
        // could be silently attached to a route, and silently moved onto it,
        // without the user ever agreeing to either. That surfaces later in
        // confusing ways, such as a route export carrying flags that look
        // unrelated. A brief notice is the minimum honest feedback; the flag
        // dialog is where it can be undone.
        showToast(`Flag bound to nearby route. Open the flag to unbind.`);
      }
    } catch (err) {
      logError(`Failed to drop flag: ${err.message}`);
    }
  }
}
map.on('click', (e) => handleMapTap(e.latlng));

function updateZoomLock() {
  if (flagModeActive || planningRoute) map.doubleClickZoom.disable();
  else map.doubleClickZoom.enable();
  updateMapTapMode();
}

// While placing flags or laying route points, every tap belongs to the
// map - map-tap-mode drops pointer-events on the vector overlay pane so
// route/track hit lines stop intercepting them (see style.css).
function updateMapTapMode() {
  document.body.classList.toggle('map-tap-mode', flagModeActive || planningRoute);
}
updateZoomLock();

// ---------- Track recording ----------
let recording = false;
let trackPoints = [];
let trackLine = null;
let trackStart = null;
let trackDistanceMiles = 0; // running total, so recordPoint doesn't re-sum the whole track every fix
let trackRejectedCount = 0;

// Fix-quality gates for RECORDING only - the live marker still shows every
// fix, because seeing a bad one jump around is useful feedback, whereas
// silently baking it into a saved track corrupts that track's distance and
// shape permanently. Thresholds are deliberately permissive: the goal is
// to drop obvious garbage, not to second-guess real movement under tree
// cover, where accuracy legitimately degrades.
const RECORD_MAX_ACCURACY_M = 100;   // beyond this the fix is nearly meaningless
const RECORD_MAX_SPEED_MPS = 45;     // ~160 km/h; anything faster is a GPS teleport, not travel

// The record button can live in two places: inside the collapsible menu, or
// pinned to the stack so it survives the menu closing. It is MOVED rather than
// duplicated, because two buttons with the same id would break every
// getElementById in this file, and a CSS-only approach cannot work: the menu
// hides with display:none on the container, which takes its children with it
// regardless of what they are styled to do.
function updateRecordButtonPlacement() {
  const btn = document.getElementById('btn-record');
  const menu = document.getElementById('fab-menu-items');
  const stack = document.getElementById('btn-fab-menu').parentElement;
  if (!btn || !menu || !stack) return;
  const alwaysOn = localStorage.getItem('persistentRecord') === 'true';
  // While recording it is pinned regardless of the setting: stopping needs to
  // be reachable in one tap, not three.
  const shouldPin = alwaysOn || recording;
  const pinned = btn.parentElement === stack;
  if (shouldPin && !pinned) stack.insertBefore(btn, document.getElementById('btn-fab-menu'));
  else if (!shouldPin && pinned) menu.appendChild(btn);
  btn.classList.toggle('pinned', shouldPin);
}

document.getElementById('btn-record').onclick = () => {
  if (recording) openStopRecordDialog();
  else openDialog('dialog-start-record');
};

// Opening this dialog does NOT stop the recording. Nothing is torn down until
// Save or Delete is chosen, which is what makes Keep recording safe: there is
// no state to put back, because none was taken apart. The previous version
// stopped first and asked afterwards, so cancelling had to correctly restore
// five separate things and any miss left the user recording invisibly.
function openStopRecordDialog() {
  const mins = Math.max(0, Math.round((Date.now() - trackStart) / 60000));
  document.getElementById('stop-record-summary').textContent =
    `${trackPoints.length} point(s) recorded over ${mins} minute(s), ${GPS.formatDistance(trackDistanceMiles, useMetric)}.`;
  openDialog('dialog-stop-record');
  // A backdrop tap is the least destructive outcome, which here means carrying
  // on recording.
  dialogDismissHandlers.set('dialog-stop-record', () => closeOverlay('dialog-stop-record'));
}

document.getElementById('btn-stop-record-cancel').onclick = () => closeOverlay('dialog-stop-record');

document.getElementById('btn-stop-record-save').onclick = async () => {
  closeOverlay('dialog-stop-record');
  // Read now rather than when the dialog opened: the user was still recording
  // the whole time it was on screen, so those points belong to the track.
  const points = trackPoints.slice();
  const startedAt = trackStart;
  endRecording();
  if (points.length < 2) {
    await showAlert('Nothing to save', 'This track has fewer than two points, so there is no path to save.');
    return;
  }
  const name = await askName('Name this track', new Date().toLocaleDateString());
  // Cancelling the NAME prompt no longer discards anything. It used to, which
  // meant a routine cancel silently destroyed hours of walking; the track is
  // saved under a default name instead and can be renamed or deleted later.
  const finalName = name === null ? `Track ${new Date().toLocaleString()}` : name;
  try {
    await Store.saveTrack({ name: finalName, points, startedAt, endedAt: Date.now() });
    await redrawAllDataFromStore();
    renderDataPanel();
    logInfo(`Track "${finalName}" saved with ${points.length} points.`);
    showToast(`Track saved: ${finalName}`);
  } catch (e) {
    logError(`Failed to save track: ${e.message}`);
    await showAlert('Could not save track', e.message);
  }
};

document.getElementById('btn-stop-record-delete').onclick = async () => {
  closeOverlay('dialog-stop-record');
  const count = trackPoints.length;
  const ok = await askConfirm('Delete this track?',
    `Discard ${count} recorded point(s)? This can't be undone, and the recording will stop.`);
  if (!ok) {
    // Declining the delete leaves the recording running, same as Keep
    // recording, because nothing has been torn down at this point either.
    return;
  }
  endRecording();
  logInfo(`Recording discarded (${count} points).`);
  showToast('Recording discarded.');
};

const persistRecordToggle = document.getElementById('toggle-persistent-record');
persistRecordToggle.checked = localStorage.getItem('persistentRecord') === 'true';
persistRecordToggle.addEventListener('change', () => {
  localStorage.setItem('persistentRecord', persistRecordToggle.checked ? 'true' : 'false');
  updateRecordButtonPlacement();
});
updateRecordButtonPlacement();

document.getElementById('btn-support').onclick = () => {
  window.open('https://ko-fi.com/corruptedwizards', '_blank', 'noopener');
};
document.getElementById('btn-start-record-yes').onclick = () => { closeOverlay('dialog-start-record'); startRecording(); };
document.getElementById('btn-start-record-no').onclick = () => closeOverlay('dialog-start-record');

function startRecording() {
  recording = true;
  trackPoints = [];
  trackDistanceMiles = 0;
  trackRejectedCount = 0;
  // Defensive: incremental appending assumes a fresh line, so make sure a
  // stray one from an interrupted session can't be appended to.
  if (trackLine) { map.removeLayer(trackLine); trackLine = null; }
  trackStart = Date.now();
  const btn = document.getElementById('btn-record');
  btn.classList.add('recording');
  btn.innerHTML = ICONS.stop;
  document.getElementById('record-status-pill').classList.remove('hidden');
  updateRecordButtonPlacement();
  logInfo('Track recording started.');
}

// Returns true if this fix is trustworthy enough to bake into a saved
// track. Rejecting is not free - a dropped point leaves a straight line
// across whatever really happened - so this only rejects fixes that are
// either measurably garbage or physically impossible.
function isFixRecordable(pos, previous) {
  if (typeof pos.accuracy === 'number' && pos.accuracy > RECORD_MAX_ACCURACY_M) return false;
  if (!previous) return true;
  const dtSec = (pos.timestamp - previous.timestamp) / 1000;
  // Non-positive or missing dt means the timestamps can't be trusted for
  // this check; fall through rather than dividing by zero.
  if (!(dtSec > 0)) return true;
  const metres = GPS.distanceMiles(previous, pos) * 1609.344;
  return (metres / dtSec) <= RECORD_MAX_SPEED_MPS;
}

function recordPoint(pos) {
  const previous = trackPoints[trackPoints.length - 1];
  if (!isFixRecordable(pos, previous)) {
    trackRejectedCount++;
    return; // dropped from the track; the live marker still moved
  }

  const point = { lat: pos.lat, lng: pos.lng, altitude: pos.altitude, timestamp: pos.timestamp };
  trackPoints.push(point);

  // Incremental, not recomputed. The previous version destroyed and
  // rebuilt the entire polyline and re-summed every segment on every
  // single fix - O(n) work per point, so O(n^2) over a recording. On a
  // multi-hour track at one fix per second that becomes thousands of
  // points reprocessed every second. Appending one point and adding one
  // segment's distance is O(1).
  if (previous) trackDistanceMiles += GPS.distanceMiles(previous, point);
  if (trackLine) trackLine.addLatLng([point.lat, point.lng]);
  else trackLine = L.polyline([[point.lat, point.lng]], { color: '#e6484f', weight: 4 }).addTo(map);

  const elapsedSec = Math.floor((Date.now() - trackStart) / 1000);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const ss = String(elapsedSec % 60).padStart(2, '0');
  document.getElementById('record-stats').textContent = `${GPS.formatDistance(trackDistanceMiles, useMetric)} · ${mm}:${ss}`;
}

// Teardown only. Deliberately separate from saving, so Save and Delete can
// each call it at the right moment and Cancel never does.
function endRecording() {
  recording = false;
  const btn = document.getElementById('btn-record');
  btn.classList.remove('recording');
  btn.innerHTML = ICONS.record;
  document.getElementById('record-status-pill').classList.add('hidden');
  updateRecordButtonPlacement();
  if (trackLine) { map.removeLayer(trackLine); trackLine = null; }
  if (trackRejectedCount) logInfo(`${trackRejectedCount} unusable GPS fix(es) were left out of this track.`);
  trackPoints = [];
  trackDistanceMiles = 0;
  trackRejectedCount = 0;
}

// ---------- Region download ----------
let selectedRegion = null;

function renderDownloadLayerChecks() {
  const container = document.getElementById('download-layer-checks');
  container.innerHTML = '';
  Object.values(LAYER_SOURCES).filter(s => s.downloadable).forEach((s) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" checked data-dl-id="${s.id}" /> ${s.label}`;
    container.appendChild(label);
  });
  container.querySelectorAll('input').forEach(cb => cb.addEventListener('input', updateEstimate));
}
renderDownloadLayerChecks();

document.getElementById('btn-region-search').onclick = runRegionSearch;
document.getElementById('region-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runRegionSearch();
});

async function runRegionSearch() {
  const query = document.getElementById('region-search-input').value;
  if (!query.trim()) return;
  const resultsBox = document.getElementById('region-search-results');
  resultsBox.innerHTML = '<div class="result-item">Searching…</div>';
  try {
    const results = await Geocode.search(query);
    const withBbox = results.filter(r => r.bbox);
    if (!withBbox.length) { resultsBox.innerHTML = '<div class="result-item">No downloadable area found for that search.</div>'; return; }
    resultsBox.innerHTML = '';
    withBbox.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'result-item';
      item.innerHTML = `${r.label}<span class="result-type">${r.placeType || ''}</span>`;
      item.onclick = () => selectRegion(r);
      resultsBox.appendChild(item);
    });
  } catch (e) {
    logError(`Region search failed: ${e.message}`);
    resultsBox.innerHTML = '<div class="result-item">Search failed - check connection.</div>';
  }
}

function selectRegion(result) {
  selectedRegion = result;
  document.getElementById('region-selected-name').textContent = result.label;
  document.getElementById('region-selected-info').classList.remove('hidden');
  document.getElementById('region-search-results').innerHTML = '';
  const b = result.bbox;
  map.fitBounds([[b.south, b.west], [b.north, b.east]]);
  updateEstimate();
  logInfo(`Region selected: ${result.label}`);
}

function updateEstimate() {
  if (!selectedRegion) return;
  const bbox = selectedRegion.bbox;
  const minZ = +document.getElementById('zoom-min').value;
  const maxZ = +document.getElementById('zoom-max').value;
  // Counted per layer rather than tiles-in-range times layer-count, because
  // layers stop at different zooms and downloadRegion clamps to each one.
  // A flat multiply would promise tiles the download correctly declines to
  // fetch, so the estimate would read high and the progress bar would appear
  // to finish early.
  let total = 0;
  const checked = Array.from(document.querySelectorAll('#download-layer-checks input:checked'));
  for (const cb of checked) {
    const source = Object.values(LAYER_SOURCES).find(s => s.id === cb.dataset.dlId);
    const ceiling = source ? (source.maxNativeZoom || source.maxZoom || 19) : 19;
    for (let z = minZ; z <= Math.min(maxZ, ceiling); z++) total += tilesInBboxAtZoom(bbox, z);
  }
  document.getElementById('estimate-readout').textContent =
    `Estimated tiles: ~${total.toLocaleString()} (roughly ${((total * 15) / 1024).toFixed(0)} MB)`;
}

function tilesInBboxAtZoom(bbox, z) {
  const n = Math.pow(2, z);
  const x1 = Math.floor(((bbox.west + 180) / 360) * n);
  const x2 = Math.floor(((bbox.east + 180) / 360) * n);
  const y1 = Math.floor(((1 - Math.log(Math.tan(bbox.north * Math.PI / 180) + 1 / Math.cos(bbox.north * Math.PI / 180)) / Math.PI) / 2) * n);
  const y2 = Math.floor(((1 - Math.log(Math.tan(bbox.south * Math.PI / 180) + 1 / Math.cos(bbox.south * Math.PI / 180)) / Math.PI) / 2) * n);
  return Math.abs(x2 - x1 + 1) * Math.abs(y2 - y1 + 1);
}

document.getElementById('zoom-min').addEventListener('input', updateEstimate);
document.getElementById('zoom-max').addEventListener('input', updateEstimate);

document.getElementById('btn-start-download').onclick = async () => {
  if (!selectedRegion) { logError('Search and select a place first.'); return; }
  const layerIds = Array.from(document.querySelectorAll('#download-layer-checks input:checked')).map(cb => cb.dataset.dlId);
  if (!layerIds.length) { logError('Pick at least one layer to download.'); return; }

  const minZoom = +document.getElementById('zoom-min').value;
  const maxZoom = +document.getElementById('zoom-max').value;

  // Reset to 0 every time - previously this only un-hid the bar without
  // resetting its fill, so a second download right after a first one
  // showed a stale full bar until the first progress event arrived.
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent = '0%';
  document.getElementById('download-progress').classList.remove('hidden');
  logInfo(`Download started: "${selectedRegion.label}", layers=${layerIds.join(',')}, zoom ${minZoom}-${maxZoom}`);

  // The progress bar was the only thing reflecting download state; the button
  // itself still read "Start download" throughout, which looks like the tap
  // never registered. Disabling it also stops a second tap from starting a
  // concurrent download over the same region.
  const startBtn = document.getElementById('btn-start-download');
  startBtn.textContent = 'Downloading\u2026';
  startBtn.disabled = true;

  try {
    await downloadRegion({
      bbox: selectedRegion.bbox, minZoom, maxZoom, layerIds,
      onProgress: (done, total) => {
        const pct = Math.round((done / total) * 100);
        document.getElementById('progress-fill').style.width = pct + '%';
        document.getElementById('progress-text').textContent = `${pct}% (${done}/${total})`;
      },
      onDone: (total) => {
        document.getElementById('progress-text').textContent = `Done - ${total} tiles cached`;
        logInfo(`Download finished: ${total} tiles.`);
        saveRegionRecord({ name: selectedRegion.label, bbox: selectedRegion.bbox, minZoom, maxZoom, layerIds });
        renderRegionsList('saved-map-regions-list-download', 'tile-cache-stats-download');
      }
    });
  } catch (e) {
    logError(`Download failed: ${e.message}`);
  } finally {
    // In finally rather than duplicated across onDone and catch: onDone only
    // fires on success, so a thrown download would otherwise leave the button
    // permanently disabled and reading "Downloading", with no way to retry
    // short of restarting the app.
    startBtn.textContent = 'Start download';
    startBtn.disabled = false;
  }
};

function saveRegionRecord(region) {
  const regions = JSON.parse(localStorage.getItem('savedRegions') || '[]');
  regions.push({ ...region, savedAt: Date.now() });
  localStorage.setItem('savedRegions', JSON.stringify(regions));
}
function getSavedRegions() {
  return JSON.parse(localStorage.getItem('savedRegions') || '[]');
}
function removeSavedRegionRecord(savedAt) {
  const regions = getSavedRegions().filter(r => r.savedAt !== savedAt);
  localStorage.setItem('savedRegions', JSON.stringify(regions));
}

// Shared renderer - used by BOTH the Download sheet and the Data sheet, so
// downloaded areas and their delete controls show up in both places
// without duplicating the logic.
async function renderRegionsList(listElId, statsElId) {
  try {
    const stats = await getTileCacheStats();
    const totalTiles = Object.values(stats).reduce((a, b) => a + b, 0);
    const usage = await estimateStorageUsage();
    const statsEl = document.getElementById(statsElId);
    if (statsEl) {
      statsEl.textContent = totalTiles > 0
        ? `All cached tiles (downloads + browsing): ${totalTiles} total · ~${usage.usageMB} MB used on device`
        : 'No cached map tiles yet.';
    }
  } catch (e) {
    logError(`Failed to read tile cache stats: ${e.message}`);
  }

  const regions = getSavedRegions();
  const listEl = document.getElementById(listElId);
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!regions.length) listEl.innerHTML = '<li>No downloaded areas yet.</li>';
  regions.forEach((region) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${region.name}<br><small>${new Date(region.savedAt).toLocaleDateString()} · zoom ${region.minZoom}-${region.maxZoom} · ${region.layerIds.join(', ')}</small></span>`;
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.onclick = async () => {
      const ok = await askConfirm('Delete downloaded area?', `Delete all downloaded tiles for "${region.name}"? You'll need to re-download to view this area offline again.`);
      if (!ok) return;
      try {
        const count = await deleteTilesInRegion(region);
        removeSavedRegionRecord(region.savedAt);
        logInfo(`Deleted ${count} tiles for "${region.name}".`);
        renderRegionsList('saved-map-regions-list-download', 'tile-cache-stats-download');
        renderRegionsList('saved-map-regions-list', 'tile-cache-stats');
      } catch (e) {
        logError(`Failed to delete region tiles: ${e.message}`);
      }
    };
    // Wrapped the same way as the presets, sessions and routes lists. The
    // .danger colours live on `.item-actions button.danger`, so a delete
    // button appended straight onto the li matches no rule at all and renders
    // as an unstyled default button. This was the actual bug behind 5.5.
    const actions = document.createElement('span');
    actions.className = 'item-actions';
    actions.appendChild(delBtn);
    li.appendChild(actions);
    listEl.appendChild(li);
  });
}

async function deleteAllMapDataFlow() {
  const ok = await askConfirm('Delete ALL downloaded map data?', 'This deletes every downloaded map area on this device. Your flags, routes, tracks, and sessions are not affected. This cannot be undone.');
  if (!ok) return;
  try {
    await deleteAllTiles();
    localStorage.removeItem('savedRegions');
    logInfo('All downloaded map data deleted.');
    renderRegionsList('saved-map-regions-list-download', 'tile-cache-stats-download');
    renderRegionsList('saved-map-regions-list', 'tile-cache-stats');
  } catch (e) {
    logError(`Failed to delete all map data: ${e.message}`);
  }
}
document.getElementById('btn-delete-all-maps').onclick = deleteAllMapDataFlow;
document.getElementById('btn-delete-all-maps-download').onclick = deleteAllMapDataFlow;

// ---------- Sessions & Data sheet ----------
let currentSessionName = null;
// Null while the working data is unsaved, in which case the mirror writes to
// current/. Set once a session is saved or loaded, which is also its folder
// name on disk.
let currentSessionId = null;

async function renderDataPanel() {
  document.getElementById('current-session-label').textContent = currentSessionName || 'Unsaved';
  renderLayerPresetsList();

  await renderSessionTree();

  renderRegionsList('saved-map-regions-list', 'tile-cache-stats');
}




// ---------- Route trimming ----------
// Shortens a saved route from either end. Distinct from the export trim, which
// only affects the file being written: this edits the stored route itself.
//
// A live preview is drawn while the sliders move, because sliders alone make
// this guesswork: "300 m from the start" means nothing without seeing which
// part of the line it removes.

let trimPreviewLine = null;
let trimContext = null;

function cumulativeMiles(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + GPS.distanceMiles(points[i - 1], points[i]));
  return out;
}

// Points remaining after removing startM from the front and endM from the
// back, measured along the path.
function slicedRoutePoints(points, cum, startM, endM) {
  const totalM = cum[cum.length - 1] * 1609.344;
  const fromM = Math.min(startM, totalM);
  const toM = Math.max(fromM, totalM - endM);
  let a = 0;
  while (a < points.length - 1 && cum[a] * 1609.344 < fromM) a++;
  let b = points.length - 1;
  while (b > a && cum[b] * 1609.344 > toM) b--;
  // A route needs two points to be a line at all, so the slice never returns
  // fewer; the dialog blocks saving in that case rather than silently keeping
  // more than the sliders show.
  if (b - a < 1) return points.slice(a, a + 2).length === 2 ? points.slice(a, a + 2) : points.slice(0, 2);
  return points.slice(a, b + 1);
}

function clearTrimPreview() {
  if (trimPreviewLine) { map.removeLayer(trimPreviewLine); trimPreviewLine = null; }
}

function renderTrimPreview() {
  if (!trimContext) return;
  const { route, cum } = trimContext;
  const startM = +document.getElementById('trim-route-start').value || 0;
  const endM = +document.getElementById('trim-route-end').value || 0;
  const kept = slicedRoutePoints(route.points, cum, startM, endM);

  clearTrimPreview();
  trimPreviewLine = L.polyline(kept.map(p => [p.lat, p.lng]), {
    color: '#f5c542', weight: 6, opacity: 0.95
  }).addTo(map);

  const keptMiles = cumulativeMiles(kept).pop() || 0;
  document.getElementById('trim-route-start-out').textContent = trimLabel(startM);
  document.getElementById('trim-route-end-out').textContent = trimLabel(endM);
  document.getElementById('trim-route-summary').textContent =
    `${GPS.formatDistance(keptMiles, useMetric)} of ${GPS.formatDistance(trimContext.totalMiles, useMetric)} kept, ${kept.length} of ${route.points.length} points.`;
  document.querySelector('#panel-trim-route .float-panel-title').textContent =
    trimContext.kind === 'track' ? 'Trim track' : 'Trim route';

  // Bound flags are the non-obvious casualty of a trim: their distance along
  // the route shifts, and any that sat on a removed section are no longer on
  // the route at all. Said up front rather than discovered afterwards.
  const affected = trimContext.boundFlags.filter(f => {
    const d = f.routeDistance;
    if (typeof d !== 'number') return false;
    return d * 1609.344 < startM || d * 1609.344 > (trimContext.totalMiles * 1609.344 - endM);
  }).length;
  const warn = document.getElementById('trim-route-warning');
  warn.textContent = kept.length < 2
    ? 'A route needs at least two points.'
    : affected
      ? `${affected} bound flag(s) fall outside the trimmed route and will be unbound.`
      : '';
  document.getElementById('btn-trim-route-save').disabled = kept.length < 2;
}

// kind is 'route' or 'track'. The geometry is identical; what differs is
// which store the result is written back to and whether bound flags exist to
// worry about. Flags bind to routes only, so a track trim has none.
async function openTrimRouteDialog(route, kind = 'route') {
  const points = route.points || [];
  if (points.length < 3) {
    await showAlert('Too short to trim', `This ${kind} needs more than two points before it can be trimmed.`);
    return;
  }
  const cum = cumulativeMiles(points);
  const totalMiles = cum[cum.length - 1];
  const totalMetres = Math.floor(totalMiles * 1609.344);
  const allFlags = kind === 'route' ? await Store.getWaypoints() : [];

  trimContext = {
    route, kind, cum, totalMiles,
    boundFlags: allFlags.filter(w => w.boundRouteId === route.id)
  };

  for (const which of ['start', 'end']) {
    const el = document.getElementById(`trim-route-${which}`);
    // Capped below the full length so the two sliders cannot between them
    // consume the entire route.
    el.max = Math.max(1, Math.floor(totalMetres * 0.45));
    el.step = Math.max(1, Math.round(totalMetres / 200));
    el.value = 0;
    el.oninput = renderTrimPreview;
  }

  map.fitBounds(points.map(p => [p.lat, p.lng]));
  renderTrimPreview();

  // Deliberately NOT openDialog: that dims the map behind a backdrop, and the
  // map is exactly what needs to stay visible here. Same reasoning as the
  // navigation route picker, which bypasses the overlay system for the same
  // reason.
  const panel = document.getElementById('panel-trim-route');
  // Placed low on the first open so it sits clear of the route, which the
  // fitBounds above has just centred. Position persists across opens once the
  // user has moved it, since they moved it somewhere for a reason.
  if (!panel.style.top) {
    panel.style.left = '50%';
    panel.style.top = `${Math.max(80, window.innerHeight - 260)}px`;
    panel.style.transform = 'translateX(-50%)';
  }
  panel.classList.remove('hidden');
  if (!panel.dataset.draggable) {
    makeDraggable(panel);
    // Wired once. Re-registering on every open would stack duplicate handlers
    // and make the panel move several times the drag distance.
    panel.dataset.draggable = 'true';
  }
}

function closeTrimRouteDialog() {
  clearTrimPreview();
  trimContext = null;
  document.getElementById('panel-trim-route').classList.add('hidden');
}

document.getElementById('btn-trim-route-cancel').onclick = closeTrimRouteDialog;

document.getElementById('btn-trim-route-save').onclick = async () => {
  if (!trimContext) return closeTrimRouteDialog();
  const { route, cum } = trimContext;
  const startM = +document.getElementById('trim-route-start').value || 0;
  const endM = +document.getElementById('trim-route-end').value || 0;
  if (!startM && !endM) return closeTrimRouteDialog();

  const kept = slicedRoutePoints(route.points, cum, startM, endM);
  if (kept.length < 2) return;
  const kind = trimContext.kind;

  const ok = await askConfirm(`Trim this ${kind}?`,
    `The ${kind} will be shortened to ${GPS.formatDistance(cumulativeMiles(kept).pop() || 0, useMetric)}. The removed sections can't be recovered.`);
  if (!ok) return;

  try {
    // slicedRoutePoints returns a slice of the original array, so a track's
    // per-point altitude and timestamp survive untouched; only the ends go.
    if (kind === 'track') await Store.saveTrack({ ...route, points: kept });
    else await Store.saveRoute({ ...route, points: kept });

    // Every bound flag's distance along the route is measured from the old
    // start, so all of them are stale after a trim, not just the ones on a
    // removed section. Re-projecting is the only way the numbers stay
    // meaningful, and anything now too far from the line is unbound.
    let rebound = 0, unbound = 0;
    for (const wp of trimContext.boundFlags) {
      const proj = GPS.projectOntoRoute(wp, kept);
      if (proj && proj.offRouteMiles * 1609.344 <= 60) {
        wp.routeDistance = proj.distanceAlongRouteMiles;
        await Store.saveWaypoint(wp);
        rebound++;
      } else {
        wp.boundRouteId = null;
        wp.routeDistance = null;
        await Store.saveWaypoint(wp);
        unbound++;
      }
    }

    closeTrimRouteDialog();
    await redrawAllDataFromStore();
    renderDataPanel();
    const extra = unbound ? ` ${unbound} flag(s) unbound, ${rebound} kept.` : '';
    const label = kind === 'track' ? 'Track' : 'Route';
    logInfo(`${label} "${route.name}" trimmed to ${kept.length} points.${extra}`);
    showToast(`${label} trimmed.${extra}`);
  } catch (e) {
    logError(`Could not trim ${kind}: ${e.message}`);
    await showAlert('Trim failed', e.message);
  }
};

// ---------- Session tree ----------
// Built entirely from the database, never from the filesystem. The mirror can
// be stale or unavailable and the tree still renders correctly, which is the
// whole point of keeping IndexedDB authoritative.

const RECORD_GROUPS = ['waypoints', 'routes', 'tracks'];
const treeExpanded = new Set(['current']);

const leafKey = (ownerKey, group, id) => `${ownerKey}/${group}/${id}`;

async function buildTreeModel() {
  const [waypoints, routes, tracks, sessions] = await Promise.all([
    Store.getWaypoints(), Store.getRoutes(), Store.getTracks(), Store.getSessions()
  ]);
  const nodes = [{
    key: 'current',
    label: currentSessionName || 'Current session',
    sub: currentSessionId ? 'Loaded' : 'Unsaved',
    sessionId: currentSessionId,
    isCurrent: true,
    groups: { waypoints, routes, tracks }
  }];
  for (const sess of sessions) {
    // The loaded session already appears as the live one at the top; listing
    // its stored snapshot again would show the same session twice, with
    // whichever copy is staler looking like a separate thing.
    if (sess.id === currentSessionId) continue;
    nodes.push({
      key: `session:${sess.id}`,
      label: sess.name,
      sub: new Date(sess.savedAt).toLocaleDateString(),
      sessionId: sess.id,
      isCurrent: false,
      groups: {
        waypoints: sess.waypoints || [], routes: sess.routes || [], tracks: sess.tracks || []
      }
    });
  }
  return nodes;
}

function leavesOf(node, group) {
  if (group) return (node.groups[group] || []).map(r => leafKey(node.key, group, r.id));
  return RECORD_GROUPS.flatMap(g => leavesOf(node, g));
}

// unchecked | indeterminate | checked, derived rather than stored.
function checkStateOf(keys) {
  if (!keys.length) return 'unchecked';
  const n = keys.filter(k => treeSelected.has(k)).length;
  return n === 0 ? 'unchecked' : n === keys.length ? 'checked' : 'indeterminate';
}

function setSelection(keys, on) {
  for (const k of keys) { if (on) treeSelected.add(k); else treeSelected.delete(k); }
}

function makeCheckbox(keys, onToggle) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'tree-check';
  const state = checkStateOf(keys);
  cb.checked = state === 'checked';
  cb.indeterminate = state === 'indeterminate';
  cb.onclick = (e) => {
    e.stopPropagation();
    // Indeterminate counts as "not all selected", so the tap selects the rest
    // rather than clearing what is already ticked.
    setSelection(keys, checkStateOf(keys) !== 'checked');
    onToggle();
  };
  return cb;
}

function treeRow({ depth, expandable, isFolder, expanded, label, sub, count, keys, active, action, onToggleExpand, onRerender }) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = `tree-row depth-${depth}${active ? ' is-active' : ''}`;

  const twisty = document.createElement('span');
  twisty.className = `tree-twisty${expandable ? '' : ' leaf'}`;
  twisty.textContent = expanded ? '\u25be' : '\u25b8';
  row.appendChild(twisty);

  if (treeSelectMode && keys && keys.length) row.appendChild(makeCheckbox(keys, onRerender));

  // Folder or file glyph, so depth is readable without counting indentation.
  // Keyed on what the row IS, not on whether it can be opened: an empty
  // tracks group is still a folder, and drawing it as a file made it look
  // like a record that happened to be called "tracks".
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = ICONS[isFolder ? 'folder' : 'file'] || '';
  row.appendChild(icon);

  const labelEl = document.createElement('span');
  labelEl.className = 'tree-label';
  const nameEl = document.createElement('span');
  nameEl.className = 'tree-name';
  nameEl.textContent = label;
  labelEl.appendChild(nameEl);
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    labelEl.appendChild(small);
  }
  row.appendChild(labelEl);

  if (typeof count === 'number') {
    const c = document.createElement('span');
    c.className = 'tree-count';
    c.textContent = String(count);
    row.appendChild(c);
  }

  // Actions are explicit buttons rather than a row tap, because the row tap is
  // already expand/collapse and the two would fight. Hidden during select mode
  // so a mis-tap while ticking boxes cannot load a session over your work.
  if (action && !treeSelectMode) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.className = 'tree-action';
    btn.onclick = (e) => { e.stopPropagation(); action.run(); };
    row.appendChild(btn);
  }

  if (expandable) row.onclick = onToggleExpand;
  li.appendChild(row);
  return li;
}

function describeRecord(group, rec) {
  if (group === 'routes' && rec.points) {
    let d = 0;
    for (let i = 1; i < rec.points.length; i++) d += GPS.distanceMiles(rec.points[i - 1], rec.points[i]);
    return `${GPS.formatDistance(d, useMetric)}, ${rec.points.length} points`;
  }
  if (group === 'tracks' && rec.points) return `${rec.points.length} points`;
  if (group === 'waypoints' && rec.boundRouteId) return 'Bound to a route';
  return '';
}

function recordAction(group, rec) {
  if (group === 'routes') {
    return { label: 'Edit', run: () => {
      map.fitBounds(rec.points.map(p => [p.lat, p.lng]));
      startRoutePlanning(rec.points, rec.id);
      closeOverlay('sheet-data');
      logInfo(`Loaded route "${rec.name}" for editing - tap to add more points, or Finish to re-save.`);
    } };
  }
  if (group === 'waypoints') {
    return { label: 'Show', run: () => { map.panTo([rec.lat, rec.lng]); closeOverlay('sheet-data'); } };
  }
  if (group === 'tracks' && rec.points && rec.points.length) {
    return { label: 'Show', run: () => { map.fitBounds(rec.points.map(p => [p.lat, p.lng])); closeOverlay('sheet-data'); } };
  }
  return null;
}

async function renderSessionTree() {
  const root = document.getElementById('session-tree');
  if (!root) return;
  const rerender = () => { renderSessionTree(); };

  // The model is read BEFORE the list is touched, and rows are built into a
  // detached fragment that replaces the old contents in one operation. The
  // previous order (clear, then await the database) left the list visibly
  // empty for the length of the read, which is the flicker seen on every
  // expand and on entering or leaving select mode.
  let nodes;
  try {
    nodes = await buildTreeModel();
  } catch (e) {
    logError(`Failed to build session list: ${e.message}`);
    return;
  }
  const frag = document.createDocumentFragment();

  for (const node of nodes) {
    const nodeLeaves = leavesOf(node);
    const total = nodeLeaves.length;
    const expanded = treeExpanded.has(node.key);
    frag.appendChild(treeRow({
      depth: 0, expandable: true, isFolder: true, expanded,
      label: node.label, sub: node.sub, count: total,
      keys: nodeLeaves, active: node.isCurrent,
      action: node.isCurrent ? null : { label: 'Load', run: () => loadSessionFlow({ id: node.sessionId, name: node.label }) },
      onToggleExpand: () => {
        if (expanded) treeExpanded.delete(node.key); else treeExpanded.add(node.key);
        rerender();
      },
      onRerender: rerender
    }));
    if (!expanded) continue;

    for (const group of RECORD_GROUPS) {
      const records = node.groups[group] || [];
      const groupKey = `${node.key}/${group}`;
      const groupExpanded = treeExpanded.has(groupKey);
      const groupLeaves = leavesOf(node, group);
      frag.appendChild(treeRow({
        depth: 1, expandable: records.length > 0, isFolder: true, expanded: groupExpanded,
        label: group, count: records.length, keys: groupLeaves,
        onToggleExpand: () => {
          if (groupExpanded) treeExpanded.delete(groupKey); else treeExpanded.add(groupKey);
          rerender();
        },
        onRerender: rerender
      }));
      if (!groupExpanded) continue;
      for (const rec of records) {
        frag.appendChild(treeRow({
          depth: 2, expandable: false, isFolder: false, expanded: false,
          label: rec.name || '(unnamed)',
          sub: describeRecord(group, rec),
          keys: [leafKey(node.key, group, rec.id)],
          // Only live records are actionable. Editing a route inside a
          // session that is not loaded would mean silently loading it first,
          // which is too much to happen from one tap.
          action: node.isCurrent ? recordAction(group, rec) : null,
          onRerender: rerender
        }));
      }
    }
  }

  if (!nodes.length) {
    const li = document.createElement('li');
    li.className = 'tree-empty';
    li.textContent = 'No sessions yet.';
    frag.appendChild(li);
  }

  // Single swap: the old rows are replaced by the new ones in one paint, so
  // there is no intermediate empty state to see.
  root.replaceChildren(frag);
}

document.getElementById('btn-tree-select').onclick = () => {
  treeSelectMode = !treeSelectMode;
  if (!treeSelectMode) treeSelected.clear();
  document.getElementById('btn-tree-select').textContent = treeSelectMode ? 'Cancel' : 'Select';
  document.getElementById('btn-tree-delete').classList.toggle('hidden', !treeSelectMode);
  renderSessionTree();
};

// Selection is cleared whenever the Data sheet closes. A selection that
// survives a close is how someone deletes something they ticked ten minutes
// ago and forgot about.
function resetTreeSelection() {
  if (!treeSelectMode && !treeSelected.size) return;
  treeSelectMode = false;
  treeSelected.clear();
  const btn = document.getElementById('btn-tree-select');
  if (btn) btn.textContent = 'Select';
  const del = document.getElementById('btn-tree-delete');
  if (del) del.classList.add('hidden');
}

document.getElementById('btn-tree-delete').onclick = async () => {
  if (!treeSelected.size) { await showAlert('Nothing selected', 'Tick the items you want to delete first.'); return; }
  const nodes = await buildTreeModel();

  // A session whose every record is ticked is treated as "delete the session",
  // which is what ticking the session checkbox visibly did. Emptying a session
  // but leaving it behind would be a surprising result of that gesture.
  const wholeSessions = [];
  const perRecord = [];
  for (const node of nodes) {
    const leaves = leavesOf(node);
    if (!leaves.length) continue;
    const selected = leaves.filter(k => treeSelected.has(k));
    if (!selected.length) continue;
    if (selected.length === leaves.length && !node.isCurrent) wholeSessions.push(node);
    else perRecord.push({ node, keys: selected });
  }

  const recordCount = perRecord.reduce((n, p) => n + p.keys.length, 0)
    + wholeSessions.reduce((n, s) => n + leavesOf(s).length, 0);
  const parts = [];
  if (wholeSessions.length) parts.push(`${wholeSessions.length} session(s)`);
  if (recordCount) parts.push(`${recordCount} item(s)`);
  const ok = await askConfirm('Delete selected?',
    `This will permanently delete ${parts.join(' and ')}, including their files. This can't be undone.`);
  if (!ok) return;

  try {
    for (const s of wholeSessions) {
      await Store.deleteSession(s.sessionId);
      try { await Storage.deleteSessionFolder(s.sessionId); }
      catch (e) { logError(`Session removed, but its folder was not deleted: ${e.message}`); }
    }
    for (const { node, keys } of perRecord) {
      for (const key of keys) {
        const [, group, id] = key.split('/');
        if (node.isCurrent) {
          // Live records go through the store, so the mirror deletes the file
          // for us via the change notification.
          if (group === 'waypoints') await Store.deleteWaypoint(id);
          else if (group === 'routes') await Store.deleteRoute(id);
          else await Store.deleteTrack(id);
        } else {
          await removeRecordFromSavedSession(node.sessionId, group, id);
        }
      }
    }
    treeSelected.clear();
    treeSelectMode = false;
    document.getElementById('btn-tree-select').textContent = 'Select';
    document.getElementById('btn-tree-delete').classList.add('hidden');
    await redrawAllDataFromStore();
    renderDataPanel();
    logInfo(`Deleted ${wholeSessions.length} session(s) and ${recordCount} item(s).`);
  } catch (e) {
    logError(`Delete failed: ${e.message}`);
    await showAlert('Delete failed', e.message);
  }
};

// Removes one record from a session that is not currently loaded. Its data
// lives in the session's stored snapshot rather than the working stores, so
// the change notification does not fire and the mirrored file has to be
// removed explicitly.
async function removeRecordFromSavedSession(sessionId, group, recordId) {
  const sessions = await Store.getSessions();
  const sess = sessions.find(x => x.id === sessionId);
  if (!sess) return;
  const list = sess[group] || [];
  const record = list.find(r => r.id === recordId);
  sess[group] = list.filter(r => r.id !== recordId);
  await Store.putSession(sess);
  if (record && Storage.isSafeSessionId(sessionId)) {
    try {
      const filename = Storage.safeFilename(`${record.name || 'untitled'}--${record.id}`, '.gpx');
      await Storage.deleteRecordFile(Storage.sessionDir(sessionId), group, filename);
    } catch (e) {
      logError(`Record removed, but its file was not deleted: ${e.message}`);
    }
  }
}

document.getElementById('btn-save-session').onclick = async () => {
  const name = await askName('Save session as', currentSessionName || `Session ${new Date().toLocaleDateString()}`);
  if (name === null) return;
  try {
    const id = Storage.makeSessionId(name);
    await Store.saveSession(name, id);
    currentSessionName = name;
    currentSessionId = id;

    // The mirror target follows the active session, so from here on edits land
    // in this session's own folder rather than continuing to pile up in
    // current/. Everything stays loaded; only where it is written changes.
    await Storage.ensureStorageRoot();
    Mirror.setActiveSession(id);
    await Mirror.rebuildMirror();
    // current/ is scratch space for unsaved work. Its contents have just been
    // written into the session folder, so leaving copies behind would make the
    // same records appear twice on disk.
    await Storage.clearCurrentFolder();

    logInfo(`Session "${name}" saved as ${id}.`);
    renderDataPanel();
  } catch (e) {
    logError(`Failed to save session: ${e.message}`);
  }
};

document.getElementById('btn-new-session').onclick = async () => {
  // Dealt with first, and separately. Clearing the session used to call the
  // old save-and-stop function, which would have prompted for a name in the
  // middle of a different flow; now that saving and stopping are split, doing
  // nothing here would silently bin an in-progress recording instead. Neither
  // is acceptable, so the recording has to be resolved on its own terms
  // before the session is touched at all.
  if (recording) {
    await showAlert('Still recording',
      'Stop the track recording first, choosing whether to save or discard it, then start the new session.');
    return;
  }
  const hasData = await Store.hasAnyCurrentData();
  if (hasData) {
    const ok = await askConfirm('Start new session?', 'You have unsaved flags, routes, or tracks. Starting a new session will clear them (downloaded map data is never affected). Save first from this menu if you want to keep them.');
    if (!ok) return;
  }
  try {
    await Store.clearCurrentData();
    clearAllDataLayers();
    currentSessionName = null;
    currentSessionId = null;
    // Back to scratch space. The saved session's folder is deliberately left
    // alone: starting a new session must never delete a session you saved.
    Mirror.setActiveSession(null);
    await Storage.clearCurrentFolder();
    cancelRoutePlanning();
    setFlagMode(false);
    logInfo('New session started.');
    renderDataPanel();
  } catch (e) {
    logError(`Failed to start new session: ${e.message}`);
  }
};

// Deleting a session removes its folder as well as its database record, so
// the confirmation states how many files that is. A session folder is often
// the only remaining copy of an old trip, and "delete 1 session" reads very
// differently from "delete 1 session and 214 files".
async function deleteSessionFlow(session) {
  let fileCount = 0;
  try {
    if (Storage.isSafeSessionId(session.id)) {
      fileCount = await Storage.countFilesUnder(Storage.sessionDir(session.id));
    }
  } catch (e) {
    // Counting is a courtesy. If storage is unavailable the database record
    // can still be deleted, and the folder cleaned up later.
  }
  const detail = fileCount
    ? `Delete saved session "${session.name}", including ${fileCount} file(s) in its folder? This can't be undone.`
    : `Delete saved session "${session.name}"? This can't be undone.`;
  const ok = await askConfirm('Delete session?', detail);
  if (!ok) return;
  try {
    await Store.deleteSession(session.id);
    try {
      await Storage.deleteSessionFolder(session.id);
    } catch (e) {
      // The guard refused, or storage is gone. The record is already deleted,
      // so say so plainly rather than implying nothing happened.
      logError(`Session removed, but its folder was not deleted: ${e.message}`);
    }
    // Deleting the session you are currently in leaves the working data
    // orphaned, so fall back to scratch space rather than continuing to mirror
    // into a folder that no longer exists.
    if (currentSessionId === session.id) {
      currentSessionId = null;
      currentSessionName = null;
      Mirror.setActiveSession(null);
    }
    logInfo(`Session "${session.name}" deleted.`);
    renderDataPanel();
  } catch (e) {
    logError(`Failed to delete session: ${e.message}`);
  }
}

async function loadSessionFlow(session) {
  const hasData = await Store.hasAnyCurrentData();
  if (hasData) {
    const ok = await askConfirm('Load session?', `Loading "${session.name}" will replace your current flags/routes/tracks (downloaded map data is never affected). Save your current work first if you want to keep it.`);
    if (!ok) return;
  }
  try {
    await Store.loadSession(session.id);
    await redrawAllDataFromStore();
    currentSessionName = session.name;
    currentSessionId = session.id;
    // Edits from here belong to the loaded session, so the mirror follows it.
    Mirror.setActiveSession(session.id);
    logInfo(`Session "${session.name}" loaded.`);
    renderDataPanel();
  } catch (e) {
    logError(`Failed to load session: ${e.message}`);
  }
}
