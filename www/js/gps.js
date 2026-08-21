// gps.js
//
// Wraps location access using the Web Geolocation API, available inside
// Capacitor's WebView the same as in any other browser. Reads the actual
// hardware GPS, not network-based location, when available - critical for
// the "works with zero signal" requirement.
//
// This used to branch on the @capacitor/geolocation plugin for finer control
// over Android's LocationRequest. That plugin's Android module hard-links a
// Google Play Services location library, which F-Droid's scanner rejects
// outright, so it was removed. Capacitor's own Bridge, not the
// plugin, is what enables WebView geolocation
// (Bridge.java: settings.setGeolocationEnabled(true)) and requests the
// ACCESS_COARSE_LOCATION/ACCESS_FINE_LOCATION runtime permission via
// BridgeWebChromeClient.onGeolocationPermissionsShowPrompt the first time
// watchPosition() is called below, so removing the plugin does not remove
// the permission prompt, confirmed directly against Capacitor's source
// rather than assumed. What IS lost: the plugin exposed
// minimumUpdateInterval and a maxUpdateDelay batching window that kept the
// marker from lagging behind real movement; the plain Web API has no
// equivalent knob, and update cadence now follows whatever interval the
// platform's own location provider defaults to. Its `timeout` is a genuine
// error timeout, unlike the plugin's batching-window meaning of the same
// name, so it stays generous here rather than short. Watch for GPS feeling
// less responsive than before on real hardware; there is nothing left to
// tune if so, it would mean revisiting this decision, not adjusting a value.

let watchId = null;
let onUpdateCallback = null;
// Tail of the resync queue. Kept even though watchPosition/clearWatch are
// synchronous now (unlike the old plugin's native-bridge calls, which is
// what originally motivated this), because stopWatching() is still async
// and still yields at least one microtask between tearing down the old
// watch and registering the new one. Three separate controls call resync()
// (the resync button, the locate button, tapping your own marker), so cheap
// insurance against two of them landing in that gap is still worth keeping.
let resyncChain = Promise.resolve();

function startWatchInternal() {
  if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      (position) => emit(position),
      (err) => notifyUpdate({ error: err.message }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  } else {
    notifyUpdate({ error: 'No geolocation available on this device.' });
  }
}

function notifyUpdate(payload) {
  if (onUpdateCallback) onUpdateCallback(payload);
}

export function startWatching(onUpdate) {
  onUpdateCallback = onUpdate;
  startWatchInternal();
}

// Tears down the current watch and starts a fresh one - a "resync" button
// for GPS position drift. Whether this actually helps depends on what's
// causing the drift: it gives the location provider a clean slate to
// reacquire from (can help if it's gotten stuck on stale internal
// averaging), but it can't do anything about real signal conditions
// (tree cover, canyon walls, being between buildings) - that's physical,
// not a state that restarting clears.
//
// Historically this had to await the teardown before registering the
// replacement, because the old plugin's clearWatch and watchPosition calls
// were both in flight natively with no defined ordering between them, and a
// teardown landing last could kill the watch that had just been created,
// leaving the UI stuck on "Resyncing" forever with no position ever
// arriving again (status only returns to 'locked' on a real position
// callback). navigator.geolocation's clearWatch/watchPosition are
// synchronous, so that specific race is gone, but resyncChain stays as
// cheap serialisation against the three controls that call this (the
// resync button, the locate button, tapping your own marker) landing in
// the one remaining microtask gap inside stopWatching().
export function resync() {
  resyncChain = resyncChain.then(async () => {
    await stopWatching();
    startWatchInternal();
  }).catch((e) => {
    // A rejection here would poison the chain and make every later resync a
    // no-op, which is the same silent dead-end this fix exists to remove.
    console.warn('resync failed:', e);
  });
  return resyncChain;
}

function emit(position) {
  const { latitude, longitude, accuracy, altitude, speed, heading } = position.coords;
  onUpdateCallback({
    lat: latitude,
    lng: longitude,
    accuracy,
    altitude,
    speed,
    heading,
    timestamp: position.timestamp
  });
}

export async function stopWatching() {
  const id = watchId;
  // Cleared before checking, so a watch registered during this call cannot
  // have its id overwritten, and a second stopWatching cannot try to clear
  // the same id twice.
  watchId = null;
  if (id == null) return;

  if (navigator.geolocation) {
    navigator.geolocation.clearWatch(id);
  }
}

// Haversine distance in miles between two {lat, lng} points - used for
// route planning distance and track recording stats.
export function distanceMiles(a, b) {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Bearing in degrees (0 = north, clockwise) from point a to point b.
export function bearingDegrees(a, b) {
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Nearest point on a single segment a->b to point p, via a flat local
// projection (equirectangular, scaled by cos(latitude) for longitude) -
// entirely appropriate at route/hiking scale, not meant for long segments.
function projectOntoSegment(p, a, b) {
  const cosLat = Math.cos(toRad(a.lat));
  const abx = (b.lng - a.lng) * cosLat, aby = b.lat - a.lat;
  const apx = (p.lng - a.lng) * cosLat, apy = p.lat - a.lat;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq === 0 ? 0 : (apx * abx + apy * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  return { lat: a.lat + aby * t, lng: a.lng + (abx * t) / cosLat, t };
}

// Projects a point onto a route (an array of {lat,lng}), returning where
// along the route you actually are - the single primitive everything
// route-navigation-related is built on: binding proximity, live "how far
// left" tracking, and the split traveled/remaining polyline all reduce to
// "find the closest point on this route, and how far along the route
// that point is."
//
// Returns null for a degenerate route (fewer than 2 points), otherwise:
//   segmentIndex        - which segment (points[i] to points[i+1]) is closest
//   projected           - {lat, lng} the actual closest point on the route
//   offRouteMiles        - perpendicular distance from p to the route
//   distanceAlongRouteMiles - distance from the route's start to the projected point
//   totalRouteMiles      - total route length
//   remainingMiles       - distanceAlongRouteMiles subtracted from the total
export function projectOntoRoute(p, points) {
  if (!points || points.length < 2) return null;
  let best = null;
  let cumulative = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const proj = projectOntoSegment(p, a, b);
    const offMiles = distanceMiles(p, proj);
    const segMiles = distanceMiles(a, b);
    if (!best || offMiles < best.offRouteMiles) {
      best = { segmentIndex: i, projected: proj, offRouteMiles: offMiles, distanceAlongRouteMiles: cumulative + segMiles * proj.t };
    }
    cumulative += segMiles;
  }
  return { ...best, totalRouteMiles: cumulative, remainingMiles: cumulative - best.distanceAlongRouteMiles };
}

// Distance along the route (from its start) to a specific point index -
// used when binding a flag that IS one of the route's own vertices
// (auto-bind via connect-the-flags), where there's no need to project
// since the point's position in the route is already known exactly.
export function distanceAlongRouteToIndex(points, index) {
  let d = 0;
  for (let i = 1; i <= index; i++) d += distanceMiles(points[i - 1], points[i]);
  return d;
}


// Formats a distance (in miles, this module's base unit throughout) for
// display, switching to the smaller unit (feet/meters) for short distances
// instead of always showing miles/km - "140 ft" reads a lot better than
// "0.03 mi" for a single short route segment. The metric crossover at
// 1000m is the obvious one (that's what makes it a kilometer); the
// imperial crossover at 528ft (0.1 mi) is a common convention in mapping
// apps for the same reason, there's no exact equivalent "clean" number.
export function formatDistance(miles, useMetric) {
  if (useMetric) {
    const meters = miles * 1609.344;
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(2)} km`;
  }
  const feet = miles * 5280;
  if (feet < 528) return `${Math.round(feet)} ft`;
  return `${miles.toFixed(2)} mi`;
}

// Vertical elevation is a different display job from horizontal distance,
// even though both are lengths, so it gets its own formatter rather than
// reusing formatDistance(). That function's switch to mi/km past a threshold
// is correct for route segments but wrong here: virtually every real-world
// elevation clears 528 ft, so it took the miles branch almost every time and
// rendered a 7,500 ft summit as "1.42 mi". Elevation is conventionally stated
// in feet or metres at any magnitude, so this never changes unit.
//
// Takes raw metres, which is what the GPS reports, instead of routing through
// miles the way the old call site did. That round trip existed only to satisfy
// formatDistance's signature and lost precision for nothing.
export function formatElevation(meters, useMetric) {
  if (typeof meters !== 'number' || isNaN(meters)) return '\u2014';
  if (useMetric) return `${Math.round(meters)} m`;
  return `${Math.round(meters * 3.280839895).toLocaleString()} ft`;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}
