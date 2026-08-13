// gps.js
//
// Wraps location access so the rest of the app doesn't care whether it's
// running inside the Capacitor native shell (real GPS chip access via the
// Geolocation plugin) or in a plain browser during development (falls back
// to the standard Web Geolocation API). Both read the actual hardware GPS,
// not network-based location, when available - critical for the "works
// with zero signal" requirement.

let watchId = null;
// Holds the still-unresolved watchPosition() promise while a registration is
// in flight. Without this, watchId is null for the whole gap between calling
// watchPosition and its promise resolving, so a teardown landing inside that
// window finds nothing to clear and silently leaks the watch that is about
// to register. stopWatching() awaits this first so it always has the real id.
let watchPending = null;
// Tail of the resync queue. See resync() for why overlapping calls have to be
// serialised rather than just individually awaited.
let resyncChain = Promise.resolve();
let onUpdateCallback = null;
let CapGeo = null;

// Capacitor's plugin registers itself globally at runtime inside the
// native shell. We try to grab it, and silently fall back to the browser
// API if it's not present (e.g. running this in a desktop browser to test
// the UI).
try {
  // eslint-disable-next-line no-undef
  CapGeo = Capacitor?.Plugins?.Geolocation || null;
} catch (e) {
  CapGeo = null;
}

function startWatchInternal() {
  if (CapGeo) {
    // Wrapped in try/catch deliberately: a single uncaught error here would
    // otherwise stop every remaining line of app.js from executing (this is
    // exactly what happened before - a crash here silently killed flags,
    // routes, tracking, and downloads too, since none of that wiring code
    // ever got a chance to run).
    try {
      const result = CapGeo.watchPosition(
        // Every value here matters more than it looks, because of how the
        // Capacitor plugin maps them onto Android's LocationRequest:
        //
        //   maximumAge: 0        - never accept a cached fix. (An earlier
        //     version used 2000, which does NOT cap staleness as the name
        //     suggests; it explicitly PERMITS a position up to 2s old.)
        //
        //   minimumUpdateInterval - becomes setMinUpdateIntervalMillis.
        //     The plugin DEFAULTS THIS TO 5000, so leaving it out caps
        //     position updates at one every five seconds no matter what
        //     else is configured. This was the dominant cause of the
        //     marker lagging behind real movement.
        //
        //   timeout              - becomes setMaxUpdateDelayMillis, which
        //     is Android's batching window, NOT an error timeout on this
        //     path. At 10000 the OS was allowed to hold updates for up to
        //     ten seconds and deliver them in a batch. Setting it below
        //     the update interval effectively disables batching, which is
        //     what live tracking wants.
        { enableHighAccuracy: true, timeout: 2000, maximumAge: 0, minimumUpdateInterval: 1000 },
        (position, err) => {
          if (err) {
            notifyUpdate({ error: err.message || String(err) });
            return;
          }
          if (position) emit(position);
        }
      );

      // Some Capacitor plugin registration paths don't return a real
      // Promise from watchPosition depending on how the bridge proxy is
      // set up - only chain .then if we actually got a thenable back.
      if (result && typeof result.then === 'function') {
        watchPending = result;
        result.then((id) => {
          watchId = id;
          watchPending = null;
        }).catch((e) => {
          watchPending = null;
          notifyUpdate({ error: `watchPosition setup failed: ${e.message || e}` });
        });
      }
    } catch (e) {
      notifyUpdate({ error: `Geolocation plugin error: ${e.message || e}` });
    }
  } else if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      (position) => emit(position),
      (err) => notifyUpdate({ error: err.message }),
      // Unlike the native path above, `timeout` here is a genuine error
      // timeout, so it stays generous - a short one would spuriously fail
      // indoors or on a cold start.
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
// Must await the teardown before registering the replacement. When these two
// ran fire-and-forget, the old watch's clearWatch and the new watch's
// registration were both in flight natively with no defined ordering, so the
// teardown could land last and kill the watch that had just been created.
// Nothing then ever delivered a position, and since status only returns to
// 'locked' on a real position callback, the UI sat on "Resyncing" forever.
//
// Serialised through a promise chain because three separate controls call
// this (the resync button, the locate button, and tapping your own marker),
// so two resyncs can genuinely overlap. Awaiting inside a single call is not
// enough on its own: two concurrent calls would each await the same pending
// registration, then one would clear the watch and the other would find
// watchId already null, clear nothing, and start a second watch anyway.
// That strands a live watch with no id anyone holds, which keeps the GPS
// chip awake and interleaves fixes from two watches into one marker.
export function resync() {
  resyncChain = resyncChain.then(async () => {
    await stopWatching();
    startWatchInternal();
    // Hold the queue until the new registration resolves, so the next
    // resync's teardown has a real id to clear rather than racing it.
    if (watchPending) {
      try {
        await watchPending;
      } catch (e) {
        // Already surfaced by startWatchInternal's own catch.
      }
    }
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
  // If a registration is still in flight, wait for its id rather than
  // tearing down nothing and leaving an orphaned watch running.
  if (watchPending) {
    try {
      await watchPending;
    } catch (e) {
      // Registration failed, so there is nothing to tear down. The error was
      // already surfaced by startWatchInternal's own catch.
    }
  }

  const id = watchId;
  // Cleared synchronously, before the await below yields, so a watch
  // registered during the teardown cannot have its id overwritten by this
  // call, and a second stopWatching cannot try to clear the same id twice.
  watchId = null;
  if (id == null) return;

  if (CapGeo) {
    try {
      await CapGeo.clearWatch({ id });
    } catch (e) {
      // Deliberately swallowed rather than routed through notifyUpdate: the
      // caller is about to start a fresh watch, and flagging GPS as errored
      // here would show a failure the user is not actually experiencing. A
      // leaked watch is the lesser problem.
      console.warn(`clearWatch failed for id ${id}:`, e);
    }
  } else if (navigator.geolocation) {
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
