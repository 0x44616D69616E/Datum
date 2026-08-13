# Datum

A fully offline topo, satellite, and trail map for Android, built for the moment you lose signal and still need to know where you are.

Datum works entirely offline once you've downloaded a region: satellite imagery, topo contours, trails, public land ownership, borders, and street labels are all cached on-device, not fetched on demand. Weather radar is the one exception, since that's inherently live data and requires a connection to be meaningful.

No account. No analytics. Nothing you record is uploaded anywhere. Your waypoints, routes, and tracks are written to a folder on your own device as standard GPX files, which means they're yours to open in other apps, back up, or share, and they never go anywhere you don't send them.

### [Download Datum v1.3.0 for Android](https://github.com/0x44616D69616E/Datum/releases/download/v1.3.0/datum-1.3.0.apk)

Free, no ads, no account, no subscription, no tracking. 6.4 MB.
[All releases](https://github.com/0x44616D69616E/Datum/releases) · [Installation help](https://freemaps.org)


## What it does

### It genuinely works with no signal

Not "mostly offline". Download a region before you leave and everything keeps working in airplane mode, deep in a canyon, with the tower thirty miles behind you: the map draws, GPS locks, waypoints drop, routes plan, tracks record. Tiles are cached on your device, not streamed on demand. The only thing that needs a connection is weather radar, because live radar can't be anything else.

### Seven map layers, stacked how you want

Satellite imagery, USGS topo, OpenTopoMap, trails, public land ownership, national and state borders, and street labels. Drag to reorder them, set transparency on each one independently, and save the result as a named preset you can reload or hand to someone else.

Which matters more than it sounds: a 26% satellite wash over USGS contours with BLM shading underneath tells you things that no single layer does.

### Know whose land you're standing on

The public land ownership layer is BLM Surface Management Agency data, the same source the agency publishes. BLM, Forest Service, state trust, wilderness, private inholdings, all colour-coded and all available offline. If you hunt, you already know why that's the layer that matters.

### Topo contours that read in feet

USGS The National Map, so contours label in feet at every zoom you'd actually hike at. OpenTopoMap is there too if you prefer metric or want the alternative styling.

### Waypoints that mean something

Thirteen icon types: water, shelter, tent, campfire, food, power, parking, photo spot, hazard, star, cache, pin, flag. Full undo and redo. Drop one near a route and it binds to it automatically, so navigation knows the order you'll reach things.

### Plan routes, record tracks

Plot a route point by point or by connecting waypoints you've already dropped. Trim it back from either end afterwards with a live preview. Record a track while you walk with live distance and time, then name and save it when you stop.

### Weather radar you can scrub through

Play or step through roughly the last two hours of radar, with a reflectivity legend taken from RainViewer's own published colour table rather than an approximation. Useful for deciding whether that cell is coming your way or going past.

### Sessions: one map per trip

A session holds a trip's waypoints, routes, and tracks. Switch sessions and the whole map swaps. Your elk scouting doesn't clutter your backpacking, and last year's trip is one tap away rather than deleted.

### Your data is yours, in a format that outlives the app

Everything is written to a folder on your device as standard GPX, automatically, as you create it. That means:

- Open your tracks in Gaia GPS, CalTopo, OsmAnd, or on a Garmin, with no export step
- Bring in a route someone sends you by tapping the file and choosing Datum
- Copy the folder anywhere as a backup that any other app can read
- Nothing is locked in a proprietary database, and nothing is uploaded to anyone

Datum-specific details like waypoint icons ride in GPX's standard extensions element, so the same file is a plain GPX to other apps and a complete record to Datum.

### Share a trail without sharing where you live

Tracks tend to start and end at your driveway, and timestamps say what hours you're out. Before sharing you can strip timestamps and trim any distance off each end of a track independently. Layer presets contain no locations at all, so those are always safe to pass around.

### Built for a phone in your hand

True-north compass needle, tap to reset rotation. Optional heading ribbon driven by the device's orientation sensor. Left-hand mode. Metric or imperial throughout, switching to feet or metres automatically for short distances. A scale bar showing miles and kilometres on one line.

### No account, no ads, no telemetry, no catch

Datum is MIT licensed and free. There is no sign-up, no subscription, no analytics SDK, and no server that could collect anything even if it wanted to. It was written because good offline mapping shouldn't cost a monthly fee.

## What's new in 1.3.0

### Changed

- **Sessions now work as containers.** Loading a session shows only that session's waypoints, routes, and tracks; everything else is hidden until you switch back. Previously every record was on the map all the time. Unsaved work lives in a `current` session until you name and save it.

### New

- **Your data is saved as standard GPX**, automatically, as you create it. Files open in Gaia GPS, CalTopo, OsmAnd, Garmin devices, and most other outdoor apps. Files from those apps import back into Datum.
- **Datum appears in the "open with" list for GPX files**, so a route someone sends you opens straight from your file manager, email, or messages.
- **USGS Topo layer**, plus a **USGS hybrid** preset. Contours read in feet at hiking zoom, unlike OpenTopoMap which labels in metres.
- **A session tree in the Data sheet**, expandable by session and record type, with a select mode for deleting several items at once. This is also the first place recorded tracks can be inspected, renamed, or deleted at all.
- **Route trimming.** Tap a route, choose Trim, and shorten it from either end with a live preview on the map.
- **Delete straight from the route popup**, without going through the Data sheet.
- **Export privacy options** for leaving out timestamps and trimming the ends of tracks, which often start at home.
- **Layer presets are shareable files** containing layer settings only, with no locations in them.

### Fixed

- GPS resync no longer gets stuck showing "Resyncing" indefinitely.
- The GPS status panel updates live while open, instead of freezing at whatever it showed when opened.
- Confirmation prompts no longer close the panel they were opened from.
- Elevation reads in feet or metres instead of being converted to miles. A 7,500 ft summit displayed as "1.42 mi".
- Rotating the map now loads the tiles the rotation exposes, instead of leaving blank edges until you zoomed.
- Offline downloads no longer request tiles that don't exist at the chosen zoom. On a large multi-layer download this was most of the requests, making downloads far slower than necessary while still reporting success.
- Flags bound to a route can be unbound. The Bind and Unbind buttons existed but were invisible, so neither had ever worked.
- Dropping a flag onto a route binds it consistently at any zoom level.
- Storage works with no setup, defaulting to `Documents/Datum`.
- Restoring a backup no longer loses your saved sessions.

Older releases are listed under [Releases](https://github.com/0x44616D69616E/Datum/releases).

## Where your data lives

Datum writes your data to a folder on your device as you create it. By default that's `Documents/Datum`, changeable in Settings.

```
Datum/
  current/                    the session you're working in now
    waypoints/  routes/  tracks/
  sessions/
    20260811T134549-pusch-ridge/
      waypoints/  routes/  tracks/
      Pusch Ridge.gpx         packaged export, written on request
  presets/                    layer presets (Datum-only format)
  backups/                    whole-app backups, written on request
```

Every waypoint, route, and track is one GPX file. Folder names follow GPX's own vocabulary, so a Datum flag is a `<wpt>` and lives in `waypoints/`.

To bring in a file someone sent you, either tap it and choose Datum, or drop it into `current/waypoints`, `current/routes`, or `current/tracks` and use Import from folder. Importing recognises files Datum wrote itself, so re-importing your own folder does nothing rather than duplicating everything.

Datum-specific details, such as waypoint icons and which route a waypoint is bound to, ride in GPX's standard `<extensions>` element. Other applications ignore what they don't recognise, so the same file is both a plain GPX for them and a complete record for Datum.

Map tiles are not stored here. They stay cached inside the app and can always be re-downloaded.

## Before you go outside: download your region

1. Open the app with a connection (needed for this step only).
2. Tap the menu → Download, search for the place you're headed, select it.
3. Pick a zoom range and which layers you want (satellite is by far the largest, leave it unchecked if you just want topo + trail to save space).
4. Tap Start Download and wait for it to finish.

After that, airplane mode works fine: map, GPS position, waypoints, routes, and recording all keep working with zero signal. Weather radar is the one layer that needs a live connection by nature.

## Building from source

This app was built and compiled entirely on an Android phone using [Termux](https://termux.dev/). No desktop required, though the same steps work on a regular Linux/Mac machine with the Android SDK installed.

### Clone and build

```bash
git clone https://github.com/0x44616D69616E/Datum.git
cd Datum
npm install
npx cap add android      # first time only
npx cap sync android
npm run fix-manifest     # must run AFTER sync, see below
cd android
./gradlew assembleDebug --no-daemon
```

The built APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`.

### After any code change

```bash
npx cap sync android
npm run fix-manifest
cd android
./gradlew assembleDebug --no-daemon
```

**Order matters.** `npx cap sync` regenerates the native Android project, including the manifest, so `npm run fix-manifest` has to run after it. Running them the other way round means sync quietly undoes the fixes.

`npm run fix-manifest` is idempotent and safe to run after every sync. It does five things, all of which `npx cap sync` would otherwise undo or never do:

1. Re-adds the location and storage permissions, which `cap sync` can silently drop from the generated Android manifest.
2. Generates `AllFilesAccessPlugin.java` and registers it, for the storage folder browser.
3. Generates `CompassSensorPlugin.java` and registers it, for the heading ribbon.
4. Registers Datum as a handler for `.gpx` files, so it appears in Android's "open with" list.
5. Sets the app name and copies the launcher icon from `resources/android/` into the native project.

The plugins are generated rather than hand-maintained, so they're safe to regenerate at any time. The script finds `MainActivity.java` by searching for it rather than deriving the path from `appId`, and those two can legitimately disagree if the Android project was generated before an app rename.

## Project structure

```
www/
  index.html               - all UI markup (sheets, dialogs, status pills)
  css/style.css            - design system
  js/
    app.js                 - main wiring: map, layers, waypoints, routes, tracks
    layers.js              - registry of every map layer source
    tileCache.js           - offline tile caching (IndexedDB) + region downloads
    dataStore.js           - IndexedDB for waypoints/routes/tracks/sessions
    mirror.js              - keeps the GPX files on disk in step with the database
    share.js               - joins records to files: import, export, adoption
    formats/gpx.js         - GPX 1.1 read and write
    storage.js             - filesystem layout, backups, session folders
    radarPlayback.js       - weather radar frame fetching + playback
    boundariesLayer.js     - bundled country/state borders (vector, offline)
    gps.js                 - Capacitor Geolocation wrapper
    compassHeading.js      - device magnetometer heading
    geocoding.js           - Nominatim place search
    icons.js               - SVG icon set + waypoint icon types
    debugOverlay.js        - on-screen debug log (Settings toggle)
  data/boundaries/         - bundled country/state GeoJSON
scripts/
  ensure-manifest-permissions.js  - re-adds permissions cap sync can drop
  ensure-storage-plugin.js        - generates + registers AllFilesAccessPlugin.java
  ensure-compass-plugin.js        - generates + registers CompassSensorPlugin.java
  ensure-gpx-intent.js            - registers Datum as a .gpx file handler
  ensure-branding.js              - sets the app name and installs the launcher icon
  lib/patchMainActivity.js        - shared MainActivity registration helper
resources/
  icon-512.png             - source app icon
  android/mipmap-*/        - generated launcher densities
```

The data layer runs one way on purpose: IndexedDB is authoritative and the folders mirror it. Datum never reads its own data back from the filesystem, so a revoked storage permission or an unmounted card can leave the mirror stale but can't stop the app or lose a record.

## Installing the APK

**[Download Datum v1.3.0](https://github.com/0x44616D69616E/Datum/releases/download/v1.3.0/datum-1.3.0.apk)**, or browse [all releases](https://github.com/0x44616D69616E/Datum/releases).

Datum isn't distributed through the Play Store, so Android shows two separate warnings the first time you install it:

1. A basic "install from unknown sources" permission prompt. Tap Settings on that screen, allow installs from the app you used to open the file, then go back and tap the file again.
2. A Google Play Protect warning saying it hasn't seen an app from this developer before. This is a "no prior history" flag, not a virus scan result. Tap "Install anyway."

Full step-by-step with screenshots is on [the website](https://freemaps.org).

## Known issues

See [GitHub Issues](https://github.com/0x44616D69616E/Datum/issues) for the current list.

## License

MIT, see [LICENSE](LICENSE). Provided as-is, with no warranty; see the Terms of Use on the website for the full disclaimer that applies to using the compiled app.

## Support

Datum is free with no ads and no subscription. If you want to support the project, there's a [Ko-fi](https://ko-fi.com/corruptedwizards). Bug reports and feature requests through GitHub Issues are just as valuable and always welcome.

## Credits

- Developed by [0x44616D69616E](https://github.com/0x44616D69616E)
- Map data: USGS The National Map, OpenTopoMap (CC-BY-SA), Esri/Maxar/Earthstar Geographics, Waymarked Trails, OpenStreetMap contributors, BLM, RainViewer, US Census Bureau, Natural Earth
- Built with [Leaflet](https://leafletjs.com/), [leaflet-rotate](https://github.com/fnicollier/Leaflet.Rotate), and [Capacitor](https://capacitorjs.com/)
