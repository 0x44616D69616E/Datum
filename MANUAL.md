# Datum User Manual

Everything Datum does, and how to get the most out of it.

This is the complete reference. If you just want to get outside, read [First run](#first-run) and [Before you lose signal](#before-you-lose-signal) and skip the rest until you need it.

---

## Contents

- [First run](#first-run)
- [Before you lose signal](#before-you-lose-signal)
- [The map screen](#the-map-screen)
- [Layers](#layers)
- [Waypoints](#waypoints)
- [Routes](#routes)
- [Navigation](#navigation)
- [Recording tracks](#recording-tracks)
- [Sessions](#sessions)
- [Offline downloads](#offline-downloads)
- [Weather radar](#weather-radar)
- [Your files](#your-files)
- [Importing](#importing)
- [Sharing and privacy](#sharing-and-privacy)
- [Settings](#settings)
- [Storage problems](#storage-problems)
- [Deleting things](#deleting-things)
- [Reference tables](#reference-tables)

---

## First run

Datum asks two things the first time you open it.

**Offline notice.** A reminder that map data has to be downloaded before you lose signal. Tap OK.

**Storage folder.** Datum writes your waypoints, routes and tracks to a folder on your device as standard GPX files. It defaults to `Documents/Datum`, which needs no setup. You can pick somewhere else, or tap "Later" and set it in Settings when you want.

If you skip storage setup, everything still works. Your data lives in the app and nothing is lost; it just is not written out as files until you choose a folder.

### Granting storage access

Choosing a folder needs Android's "All files access" permission. Datum opens the system settings page for you; turn on the toggle for Datum and come back.

This permission sounds broad because Android has no narrower option for writing to a folder you chose. Datum only ever reads and writes inside the folder you pick.

---

## Before you lose signal

The single most important thing to do before a trip.

1. Open Datum somewhere with a connection.
2. Tap the **download icon** in the button column, or the menu then Download.
3. Search for where you are going: a city, county, state or country.
4. Pick the area from the results. The map moves to show it.
5. Choose your **zoom range** and **which layers** to include.
6. Tap **Start download** and wait.

Once that finishes, put the phone in airplane mode and check the map still draws. Everything except weather radar works with no signal at all.

### Choosing a zoom range

Zoom is how close in the map can go. Each zoom level has roughly four times as many tiles as the one below it, so the top of your range decides almost all of the download size.

| Zoom | Roughly | Good for |
|---|---|---|
| 8 to 11 | Region overview | Seeing where you are in a state |
| 12 to 14 | Local area | Driving, general orientation |
| 15 to 16 | Detailed | Hiking, most trail work |
| 17 to 18 | Very close | Reading individual buildings |

Zoom 16 is enough for almost all hiking. Going to 18 multiplies the download by about sixteen times for detail you rarely need on foot.

### Choosing layers

Satellite is by far the biggest. If you want topo and trails only, leave satellite unchecked and the download shrinks dramatically.

Datum will not request tiles above a layer's own maximum zoom, so asking for zoom 18 on a layer that only publishes to 16 costs nothing.

---

## The map screen

### Top bar

- **Search** for a place, an address, or coordinates as `lat,lng`. Needs a connection.
- **Settings** (gear icon).

### GPS chip

Top left. The dot tells you the state of your position fix:

| Colour | Meaning |
|---|---|
| Green | Good fix |
| Amber | Usable but imprecise |
| Red | Poor or no fix |

Tap it for details: coordinates, accuracy, elevation, and how long since the last update. That panel stays live while it is open. It also has a **Resync** button if the fix has gone stale.

### Compass ribbon

Below the search bar. A horizontal strip showing which way the device is pointing, with the current bearing in degrees.

Tap it to open north calibration. If the ribbon consistently reads wrong, you can nudge which direction Datum calls north. This is an offset, not a freeze: the heading still comes live from the sensors.

Turn the ribbon off in Settings if you do not want it.

### The button column

Down the right side, or the left if you turn on left-hand mode.

| Button | What it does |
|---|---|
| Compass | Straighten the map, or lock it to your heading. See below |
| Locate | Centre on your position |
| Layers | Open the layer list |
| Download | Open the download screen |
| Data | Open sessions, sharing and imports |
| Flag | Turn waypoint mode on or off |
| Route | Start planning a route |
| Record | Start or stop recording a track |
| Menu | Show or hide the buttons above |

### The compass button

It does three things depending on where the map is:

| Map state | Tap does |
|---|---|
| Rotated away from north | Straightens to north |
| North up, not locked | Locks the map to the direction you are facing |
| Locked | Unlocks and returns to north |

**Hold it** to lock to your heading immediately, without straightening first.

The needle on the button rotates with the map, so you can always see which of those a tap will do.

### Rotating the map

Twist with two fingers. Tap the compass button to straighten it again.

### Scale bar

Bottom left, showing miles and kilometres on one bar regardless of your unit setting. Hide it in Settings if it is in the way.

---

## Layers

Tap the layers button. Everything about how the map is drawn lives here.

### The list

Layers draw in the order shown, top of the list on top of the map.

- **Drag the handle** on the left to reorder.
- **Checkbox** to show or hide.
- **Slider** on the right for transparency.

Transparency is what makes layer stacking useful. Satellite at about a quarter opacity over USGS topo gives you contours you can read with imagery showing through, which neither layer gives you alone.

### The layers

| Layer | Source | What it gives you |
|---|---|---|
| Satellite | Esri, Maxar, Earthstar | Aerial imagery |
| USGS Topo | USGS The National Map | Contours labelled in feet |
| Topo | OpenTopoMap | Contours labelled in metres, different styling |
| Trails | Waymarked Trails | Marked hiking and cycling routes |
| Public Land Ownership | BLM Surface Management Agency | Who owns or manages the ground |
| Borders | US Census, Natural Earth | State and country lines, works offline from bundled data |
| Street & Place Labels | OpenStreetMap | Road and place names |
| Weather Radar | RainViewer | Live precipitation, needs a connection |

### Public land ownership

The layer most likely to be the reason you installed this. It colours the map by managing agency: BLM, Forest Service, National Park Service, Fish and Wildlife, state land, tribal land, military, and private or unknown.

Tap the legend at the bottom left to expand or collapse it.

The data comes from BLM's own published service and is cached like any other layer, so it works offline once downloaded.

### Presets

A preset saves the whole arrangement: which layers, in what order, at what transparency.

- **Save current layers as preset** names and stores the current setup.
- **Load presets from folder** picks up presets shared with you.

Built-in presets: Satellite only, Topo only, Hybrid, and USGS hybrid.

Presets are written to your storage folder as small files. **They contain layer settings only, no locations**, so they are safe to send to anyone.

---

## Waypoints

A waypoint is a single marked spot. Datum sometimes calls them flags.

### Dropping one

1. Tap the **flag button** to enter waypoint mode. The button turns blue.
2. Tap the map where you want it.
3. Name it, pick an icon, and save.

The flag button stays on, so you can drop several in a row. Tap it again to leave waypoint mode.

### Icons

Thirteen types: Flag, Pin, Water, Shelter, Tent/camp, Campfire, Food/water source, Power, Parking/trailhead, Photo spot, Danger/hazard, Star/favourite, Cache/storage.

Pick from the grid in the waypoint dialog. The icon is saved with the waypoint and travels with it into GPX files.

### Undo and redo

The waypoint panel has undo and redo arrows. They cover dropping and deleting within the current session of work.

### Editing

Tap an existing waypoint to open it. You can rename it, change its icon, bind or unbind it from a route, or delete it.

### Binding to a route

If you drop a waypoint close to a route, Datum binds it to that route automatically and snaps it onto the line. A message tells you when this happens.

Binding means navigation knows the order you will reach things.

**Unbinding puts it back.** Because an automatic bind moved the waypoint without asking, unbinding returns it to exactly where you dropped it. If you bound it deliberately with the Bind button, unbinding leaves it where it is, because moving it there was the point.

If two routes are equally close, Datum asks which one you meant rather than guessing.

---

## Routes

A route is a planned path you draw. Distinct from a track, which is a path you actually walked.

### Planning point by point

1. Tap the **route button**.
2. Tap the map to place each point in turn.
3. A running distance shows as you go.
4. Tap **Finish** and name it.

**Undo and redo** are available while planning. **Cancel** discards the whole thing.

### Building from waypoints

If you already have waypoints down, Datum offers to connect them instead of making you tap each spot again. Choose this from the route mode prompt.

### Working with a saved route

Tap the route line on the map:

- **More** opens details: total distance, a segment by segment breakdown, rename, delete, and start navigation.
- **Trim** shortens it from either end.
- **Delete** removes it, after confirmation.

### Trimming a route

Trim opens a small panel with two sliders, one for each end, and **draws a live preview on the map** as you drag. The panel is draggable, so it never has to cover the part you are judging.

The summary tells you distance kept versus total and points kept versus total.

**Bound waypoints are handled.** Every bound waypoint's distance along the route is measured from the old start, so all of them go stale after a trim. Datum re-projects them onto the new line, and anything now too far off is unbound. It tells you how many before you save.

The sliders are capped so the two together cannot consume the whole route.

---

## Navigation

From a route's details, tap **Start navigation**.

While navigating:

- A bar at the bottom shows distance to the next waypoint and total remaining.
- The map locks to your heading.
- Bound waypoints are announced in the order you reach them.

Tap **Stop** to end it. Your previous heading lock setting is restored, rather than being forced either way.

If you are near a saved route, Datum may offer to start navigating it without you going through the menu.

---

## Recording tracks

A track is where you actually went, logged from GPS.

### Starting

Tap the **record button** and confirm. The button turns red and pulses, and a status pill shows live distance and elapsed time.

### While recording

Everything else keeps working. You can drop waypoints, change layers, and browse the map.

Points that fail a quality check are left out rather than dragging the track sideways. Datum tells you how many at the end.

### Stopping

Tap the record button again. **Tapping it does not stop the recording**; it opens a dialog with three choices:

| Choice | What happens |
|---|---|
| Save track | Stops and prompts for a name |
| Delete track | Stops and discards, after confirming the point count |
| Keep recording | Nothing changes; you were never interrupted |

Because nothing is torn down until you choose, "Keep recording" is genuinely free.

If you cancel the naming prompt after choosing Save, the track is **still saved** under a default name. You can rename it later.

### Keeping the button reachable

Turn on **Record button always on screen** in Settings and the record button stays visible with the menu closed.

It pins itself there while recording regardless of that setting, so stopping is always one tap.

### Working with a saved track

Tap the track line for the same three options as a route: More, Trim, Delete.

Track details show start and finish times, duration, average pace, elevation gain and point count, rather than a segment list. A recording has a point every few seconds, so a segment list would be thousands of rows.

Trimming a track keeps each point's altitude and timestamp; only the ends are removed. Useful for cutting off the walk from the car.

---

## Sessions

A session holds one trip's waypoints, routes and tracks.

**One session is active at a time, and loading one replaces what is on the map.** Your elk scouting does not clutter your backpacking.

### How it works

Anything you create goes into the **current session**, which is unsaved working space. When you name and save it, it becomes a session with its own folder.

### Saving

Data sheet, then **Save session**. Name it and everything currently on the map is stored under that name. It stays loaded, so you can carry on.

A loaded session keeps updating as you work. There is no need to re-save after every change.

### Starting fresh

**New session** clears the map for a new trip. It warns you if there is unsaved work.

You cannot start a new session while recording a track. Finish the recording first, deciding whether to save or discard it.

### Loading

The Data sheet lists every saved session. Loading one swaps the map to it.

### The data tree

The Data sheet shows a tree: sessions at the top level, then waypoints, routes and tracks inside each.

- Tap a row to expand it.
- Tap **Select** for multi-select mode with checkboxes.
- Ticking a session ticks everything inside it.
- **Delete selected** removes what you ticked.

Ticking a whole saved session deletes the session. Partial selections delete individual records.

---

## Offline downloads

### Downloading an area

Covered in [Before you lose signal](#before-you-lose-signal).

### Managing what you have

The download screen lists your saved areas and shows total cached tiles and space used.

**Downloading does not duplicate.** Download a larger area covering one you already have and the smaller record is replaced. Download the same area again with different layers and the two merge into one entry. Tiles were never fetched twice; this keeps the list honest about it.

**After a download finishes**, the button stays disabled and reads "Downloaded". Search for a new area and it comes back.

### Two kinds of cached tiles

| Kind | Where from | How to clear |
|---|---|---|
| Downloaded regions | Areas you chose deliberately | Delete the area, or Delete all map data |
| Browsing cache | Picked up as you pan around | Settings, Clear browsing cache |

Clearing the browsing cache frees space without touching downloads. Those tiles come back on their own next time you have a connection.

---

## Weather radar

Turn on the Weather Radar layer. **This is the one feature that needs a connection**, because live radar cannot be anything else.

Controls appear at the bottom: play, step forward, step back, through roughly the last two hours.

The legend uses RainViewer's own published colour table, so the intensities mean what they say.

---

## Your files

Datum writes everything to your storage folder as standard GPX, automatically, as you create it. There is no export step.

```
Datum/
  current/                    the session you are working in
    waypoints/  routes/  tracks/
  sessions/
    20260811T134549-pusch-ridge/
      waypoints/  routes/  tracks/
      Pusch Ridge.gpx         packaged export, written on request
  presets/                    layer presets
  backups/                    whole-app backups, written on request
```

Every waypoint, route and track is one GPX file. Folder names follow GPX's own vocabulary, so a flag is a `<wpt>` and lives in `waypoints/`.

Session folders are named with a timestamp and the session name, which sorts them chronologically and keeps them readable.

**These files are yours.** Open them in Gaia GPS, CalTopo, OsmAnd, on a Garmin, or anything else that reads GPX. Copy the folder anywhere as a backup.

Datum-specific details like waypoint icons ride in GPX's standard `<extensions>` element. Other applications ignore what they do not recognise, so the same file is a plain GPX to them and a complete record to Datum.

**Map tiles are not stored here.** They live inside the app and can always be downloaded again.

### One-way by design

The files mirror the app, not the other way round. Datum never reads its own folder back on its own, so a revoked permission or an unplugged card can leave the files stale but cannot stop the app or lose a record.

Bringing files in is always something you ask for. See [Importing](#importing).

---

## Importing

Three ways in, depending on where the file is.

### Tap a GPX anywhere

Datum registers as a handler for `.gpx` files. Tap one in a file manager, email or messages and choose Datum. It lands in your current session.

### Import a file

Data sheet, then **Import a file**. Browse anywhere on your device, tap a GPX, or import every GPX in the folder you are looking at.

Either way you choose where it goes:

| Choice | Result |
|---|---|
| Add to current session | Joins what you are working on |
| Load as a new session | Kept separate, with its own name |

If you have unsaved work and choose a new session, Datum offers to save your work first rather than replacing it.

### Sync from folder

For things you copied into the Datum folder yourself.

Data sheet, then **Sync from folder**. Datum scans for anything it does not already have:

- **A whole session folder** dropped into `sessions/` becomes a session.
- **Loose files** in `current/waypoints`, `current/routes` or `current/tracks` join your current session.

Files Datum wrote itself are recognised and skipped, so running sync twice does nothing.

This is also how you recover after reinstalling: point Datum at your old folder and sync.

---

## Sharing and privacy

### Sending one file

Data sheet, then **Package session as one file**. Writes a single GPX containing an entire session into that session's folder.

### Before you share

Two options in the Data sheet, both remembered between launches:

**Include times.** Off by default. A path alone shows where a trail goes; timestamps also show what hours you were out and, by implication, when your home was empty.

**Trim the ends of tracks.** Tracks usually start and end at your driveway. Two sliders remove a distance from each end independently, keeping the useful middle.

### Layer presets

Contain layer settings only, no locations. Always safe to share.

### Backups

**Export backup** writes everything to a single file. **Import backup** restores it. Manual, not automatic, and unrelated to the continuous GPX mirroring.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| Liquid glass theme | Off | Translucent panels that keep the map visible behind them. Classic is the solid look, easier to read in bright sun and slightly lighter on the battery |
| Metric units | Off | Kilometres and metres instead of miles and feet, throughout. The scale bar always shows both |
| Left-hand mode | Off | Moves the button column to the left |
| Show compass | On | The heading ribbon under the search bar |
| Hide scale bar | Off | Removes the scale bar |
| Record button always on screen | Off | Keeps the record button visible with the menu closed |
| Debug mode | Off | An on-screen log of what the app is doing, for troubleshooting |

Also in Settings: storage folder, map tile cache, delete all data, and About.

---

## Storage problems

If Datum cannot write to your storage folder, **the menu button turns red with an exclamation mark**, and so does the data button.

Open the Data sheet and you will see what did not save, with two buttons:

- **Try again** retries everything outstanding. It recreates the storage folder first, since the usual cause is a folder that went away.
- **Check storage permissions** opens Android's permission screen for Datum.

Datum remembers what still needs writing, **even if you close the app**, because storage being unavailable often outlasts the session that hit it.

Your data is safe in the app throughout. It just is not in your files yet.

### Common causes

- Storage permission was revoked or never granted
- The folder was deleted or renamed from a file manager
- An SD card was removed
- The device is full

---

## Deleting things

From least to most destructive.

| Action | Where | Removes |
|---|---|---|
| Delete a waypoint, route or track | Tap it, or the data tree | That one record and its file |
| Delete selected | Data tree, select mode | Everything ticked |
| Delete a session | Data tree | The session and its folder |
| Delete a downloaded area | Download screen | That area's tiles |
| Clear browsing cache | Settings | Tiles cached by panning, not your downloads |
| Delete all map data | Download screen | Every cached tile |
| Delete all Datum data | Settings | Everything, see below |

### Delete all Datum data

Removes the storage folder **and** the database. Deleting only the folder would not work: the mirror would write everything straight back out.

Two checkboxes let you keep parts:

- **Keep downloaded map tiles**, if you want to clear your GPX data but not re-download maps.
- **Keep settings**, including your layer setup and storage folder choice.

The dialog states file, session and tile counts before you commit, and asks a second time.

**Worth knowing:** uninstalling an Android app does not remove what it wrote to shared storage. If you want to leave no trace, do this before uninstalling.

---

## Reference tables

### Waypoint icons

| Icon | Typical use |
|---|---|
| Flag | General marker |
| Pin | General marker, alternative shape |
| Water | Spring, tank, reliable source |
| Shelter | Cabin, lean-to, shelter |
| Tent/camp | Campsite |
| Campfire | Fire ring, established fire spot |
| Food/water source | Resupply, cache |
| Power | Charging, outlet, generator |
| Parking/trailhead | Where you left the vehicle |
| Photo spot | Viewpoint |
| Danger/hazard | Washout, cliff, bad crossing |
| Star/favourite | Anything worth returning to |
| Cache/storage | Stashed gear |

### Layer maximum zoom

Datum will not request tiles above these, so asking for more costs nothing.

| Layer | Max zoom |
|---|---|
| Satellite | 18 |
| Trails | 18 |
| Topo (OpenTopoMap) | 17 |
| USGS Topo | 16 |
| Public Land Ownership | 16 |

### Gestures

| Gesture | Does |
|---|---|
| Pinch | Zoom |
| Two-finger twist | Rotate the map |
| Tap the compass | Straighten, then lock, then unlock |
| Hold the compass | Lock to heading immediately |
| Drag a sheet handle down | Peek at the map, or flick to close |
| Drag a dialog | Move it out of the way |
| Tap a route or track | Open its actions |

### What needs a connection

| Feature | Offline? |
|---|---|
| Map, GPS, waypoints, routes, tracks | Yes, fully |
| Downloaded areas | Yes |
| Search | No |
| Downloading new areas | No |
| Weather radar | No |

---

## Getting help

Bug reports and feature requests: [GitHub Issues](https://github.com/0x44616D69616E/Datum/issues).

Turning on **Debug mode** in Settings gives you an on-screen log, which is worth including in a bug report.
