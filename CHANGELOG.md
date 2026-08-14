# Changelog

All notable changes to Datum are documented here.

## v1.5.0

### Added

- **Import a file from anywhere on your device.** Browse to a GPX, or import
  every GPX in a folder, and choose whether it joins your current session or
  loads as a new one. If you have unsaved work, Datum offers to save it first
  rather than replacing it.
- **Sync from folder.** Anything copied into your Datum folder from outside
  the app can now be brought in. Drop a whole session folder into
  **sessions/** and it becomes a session; drop files into **current/waypoints**,
  **routes** or **tracks** and they join what you are working on. Files Datum
  wrote itself are recognised and left alone.
- **Recorded tracks now have the same options as plotted routes.** Tap a track
  for More, Trim and Delete. Track details show start and finish times,
  duration, average pace, elevation gain and point count.
- **A warning when files cannot be written.** If Datum loses access to your
  storage folder, the menu button turns red and the Data sheet lists what did
  not save, with a retry and a shortcut to Android's permission screen. Datum
  remembers what still needs writing, even across a restart.
- **Delete all Datum data**, in Settings. Removes the storage folder and the
  database, with the option to keep downloaded map tiles or your settings.
  Uninstalling the app does not do this on its own, because the storage folder
  lives outside the app.

### Fixed

- Renaming a route or track no longer leaves the old file behind, which used
  to put the same record on disk twice under two different names.
- Files that failed to write while storage was unavailable are no longer
  forgotten. They are queued and can be retried once access is restored.

## v1.4.0

### Added

- **Liquid glass theme**, an optional translucent look that keeps the map
  visible behind panels, menus and popups. Off by default; toggle it in
  Settings. Classic is unchanged.
- **Record button can stay on screen** with the menu closed, so you can start
  and stop a recording in one tap. Toggle in Settings. It stays visible while
  recording regardless of the setting.
- **Recorded tracks now have the same options as plotted routes.** Tap a track
  for More, Trim and Delete.
- **Track details** show a summary of the recording: start and finish times,
  duration, average pace, elevation gain and point count.
- **Bottom sheets can be pulled down** by their handle to peek at the map, and
  flicked down to close. Dialogs can be dragged out of the way.
- **About section in Settings**, with a link to the source and a way to
  support the project.

### Changed

- **Timestamps are now left out of shared files by default.** A path alone
  shows where a trail goes; timestamps also show what hours you were out. Turn
  them back on in the share options if you want them.
- **Export options are remembered** between launches, along with the trim
  settings.
- **Stopping a recording now asks what to do with it**, offering save, delete,
  or keep recording. Tapping the record button no longer stops the recording
  by itself; it only stops when you choose.

### Fixed

- **Cancelling the "name this track" prompt no longer deletes the recording.**
  It previously discarded the track with no warning. Tracks now save under a
  default name you can change later.
- **Starting a new session while recording no longer discards the track.**
  Datum now asks you to finish the recording first.
- Sheets now slide open and closed instead of appearing instantly. The
  animation existed but had never been able to run.
- The compass no longer shows a BETA label.

## v1.3.0

### Changed

- **Sessions now work as containers.** Loading a session shows only that
  session's waypoints, routes and tracks; everything else is hidden until you
  switch back. Unsaved work lives in a "current" session until you name and
  save it.

### Added

- **USGS Topo layer**, off by default. Contours read in feet at hiking zoom,
  unlike the existing OpenTopoMap layer which labels in metres.
- **USGS hybrid** layer preset.
- **Standard GPX files.** Waypoints, routes and tracks are written to your
  storage folder as GPX as you create them, so they open in Gaia GPS, CalTopo,
  OsmAnd, Garmin devices and most other outdoor apps. Files from those apps
  can be imported back in.
- **Datum appears in the "open with" list for GPX files**, so a route someone
  sends you can be opened straight from a file manager, email or messages.
- **A session tree in the Data sheet**, expandable by session and record type,
  with a select mode for deleting several items at once. This is also the
  first place waypoints and recorded tracks can be inspected, renamed or
  deleted at all.
- **Route trimming**, with a live preview on the map.
- **Delete button on the route popup.**
- **Export privacy options** for leaving out timestamps and trimming the ends
  of tracks.
- **Layer presets are saved as shareable files** containing layer settings
  only, with no locations in them.

### Fixed

- Confirmation prompts no longer close the panel they were opened from.
- GPS resync no longer gets stuck showing "Resyncing" indefinitely.
- The GPS status panel updates live while open instead of freezing.
- Elevation reads in feet or metres instead of being converted to miles. A
  7,500 ft summit displayed as "1.42 mi".
- Rotating the map now loads the tiles the rotation exposes.
- Offline downloads no longer request tiles that do not exist at the chosen
  zoom. On a large multi-layer download this was most of the requests.
- Flags bound to a route can be unbound. The Bind and Unbind buttons existed
  but were invisible, so neither had ever been usable.
- Dropping a flag onto a route binds it consistently at any zoom level.
- Storage works with no setup, defaulting to Documents/Datum.
- Exporting no longer reports success when nothing was written.
- Restoring a backup no longer loses your saved sessions.
- The download button shows progress and cannot be tapped into a duplicate
  download of the same area.

## v1.2.0

Rebrand to Datum, route navigation, waypoint binding, heading lock, left-hand
mode, GPS and compass fixes.

## v1.1.0

Compass ribbon, unit toggle, folder browser, GPS status, radar fixes.
