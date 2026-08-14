# Changelog

All notable changes to Datum are documented here.

## v1.3.0

### Changed

- **Sessions now work as containers.** Loading a session shows only that
  session's waypoints, routes and tracks; everything else is hidden until you
  switch back. Previously every record was on the map all the time. Unsaved
  work lives in a "current" session until you name and save it.

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
- **A session tree in the Data sheet**, expandable by session and by record
  type, with a select mode for deleting several items at once. This is also
  the first place waypoints and recorded tracks can be inspected, renamed or
  deleted at all.
- **Route trimming.** Tap a route and choose Trim to shorten it from either
  end, with a live preview on the map.
- **Delete button on the route popup**, so a route can be removed by tapping
  it on the map. Still confirms first.
- **Export privacy options** for leaving out timestamps and trimming the ends
  of tracks, which often start at home.
- **Layer presets are saved as shareable files** containing layer settings
  only, with no locations in them.

### Fixed

- Confirmation prompts no longer close the panel they were opened from.
  Deleting several saved areas in a row, or setting the storage folder and
  checking it took, no longer means reopening the panel each time.
- GPS resync no longer gets stuck showing "Resyncing" indefinitely.
- The GPS status panel updates live while open. Position, accuracy, elevation
  and time since last fix previously froze at whatever they were when it was
  opened.
- Elevation reads in feet or metres instead of being converted to miles or
  kilometres. A 7,500 ft summit displayed as "1.42 mi".
- Rotating the map loads the tiles the rotation exposes. The outer edges
  previously stayed blank until a zoom forced them to load.
- Offline downloads no longer request map tiles that do not exist at the
  chosen zoom. On a large multi-layer download this was most of the job, making
  downloads far slower than necessary while still reporting success. Size
  estimates are correspondingly more accurate.
- Flags bound to a route can be unbound. The Bind and Unbind buttons were
  present but invisible, so neither had ever been usable.
- Dropping a flag onto a route binds it consistently at any zoom. The target
  area was previously measured in real-world distance, making it large when
  zoomed in and almost impossible to hit when zoomed out.
- Binding a flag to a route now tells you it happened rather than doing it
  silently.
- Storage works without setup, saving to Documents/Datum by default.
- Exporting no longer reports success when nothing was written, and recreates
  the storage folder if it has been deleted.
- Restoring a backup no longer loses your saved sessions.
- The download button shows progress and cannot be tapped into a duplicate
  download of the same area.
- Delete buttons across the Data sheet are consistently styled and sized.

## v1.2.0

Rebrand to Datum, route navigation, waypoint binding, heading lock, left-hand
mode, GPS and compass fixes.

## v1.1.0

Compass ribbon, unit toggle, folder browser, GPS status, radar fixes.
