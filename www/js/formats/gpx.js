// formats/gpx.js
// GPX 1.1 read and write. This is Datum's interchange format with the rest of
// the world: Garmin, Gaia GPS, CalTopo, Avenza, OsmAnd, Komoot and most
// handheld units all read it.
//
// The reason this is one module rather than four exporters is that GPX's three
// element types map exactly onto Datum's three data types, and a single GPX
// document may contain any mix of them:
//
//   <wpt>  single point of interest      -> Datum flag
//   <rte>  ordered planned point list    -> Datum route (plotted)
//   <trk>  recorded breadcrumb trail     -> Datum track (recorded)
//
// A session is a snapshot of all three, so a session is simply a GPX document
// that contains all three. Exporting one flag and exporting a whole session
// are the same code path with different inputs.
//
// Datum-specific fields (icon type, route binding) go in <extensions>, which
// GPX 1.1 provides precisely for this. Other applications ignore that element,
// so a file stays useful to them while round-tripping losslessly back into
// Datum.
//
// Known limitation: GPX has no polygon type. If Datum ever gains drawn areas
// they cannot be carried here and will need GeoJSON or KML alongside.

const NS = 'http://www.topografix.com/GPX/1/1';
const DATUM_NS = 'https://freemaps.org/datum/gpx/1';
export const GPX_EXTENSION = '.gpx';

// GPX <sym> is core spec, not an extension, so these survive even when Datum
// extras are switched off and are the only part of a flag's appearance that
// transfers to a handheld natively.
//
// Garmin matches these by exact spelling, including capitalisation and commas
// ("Pin, Blue", not "Pin"), and an unmatched name silently falls back to a
// default marker rather than failing. Devices and BaseCamp also do not carry
// identical symbol sets, so the same file can render differently on each.
// Treat these as best effort: the authoritative value is always the
// datum:iconType extension, which is what a round trip back into Datum reads.
const SYM_BY_ICON_TYPE = {
  flag: 'Flag, Red', pin: 'Pin, Blue', water: 'Drinking Water', shelter: 'Lodging',
  tent: 'Campground', campfire: 'Campground', food: 'Restaurant',
  power: 'Residence', parking: 'Parking Area', photo: 'Scenic Area',
  danger: 'Skull and Crossbones', star: 'Flag, Blue', chest: 'Geocache'
};

function esc(str) {
  return String(str ?? '').replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

// GPX wants ISO 8601. Anything unparseable is omitted rather than written as
// "Invalid Date", which would make the file fail schema validation elsewhere.
function iso(ms) {
  if (ms == null) return null;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Privacy transforms, applied at export time only
// ---------------------------------------------------------------------------
//
// Location data is the sensitive part of this app, and the risk is not the file
// sitting on your own phone, it is what a shared file discloses. Two things
// matter more than anything else:
//
//   Timestamps. A path alone says where a trail goes. A path with times says
//   what hours you are out and, by implication, when your home is empty.
//
//   Endpoints. Tracks routinely start and stop at a driveway. Trimming the
//   ends keeps the useful middle of a trail without publishing where you live.
//
// Both are opt-in per export rather than global, because a track shared with a
// friend and a track posted publicly want different answers.

const EARTH_RADIUS_M = 6371000;
function metresBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Drops leading and trailing points until `metres` of travel has been removed
// from each end. Measured along the path rather than as straight-line distance
// from the endpoint, so a track that loops back past its own start is not
// under-trimmed.
// Start and end are separate: a track often begins at home and ends at a
// trailhead car park, or the other way round, so trimming both by the same
// amount either over-trims one end or under-protects the other.
export function trimTrackEnds(points, startMetres, endMetres) {
  const from = Math.max(0, startMetres || 0);
  const to = Math.max(0, endMetres == null ? startMetres || 0 : endMetres);
  if ((!from && !to) || !Array.isArray(points) || points.length < 3) return points;

  let start = 0;
  let travelled = 0;
  while (from && start < points.length - 1 && travelled < from) {
    travelled += metresBetween(points[start], points[start + 1]);
    start++;
  }

  let end = points.length - 1;
  travelled = 0;
  while (to && end > start && travelled < to) {
    travelled += metresBetween(points[end], points[end - 1]);
    end--;
  }

  // If the trim would consume the whole track, keep nothing rather than
  // returning a misleading two-point stub that still exposes both ends.
  if (end - start < 2) return [];
  return points.slice(start, end + 1);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function extensionsBlock(pairs, indent, enabled = true) {
  if (!enabled) return '';
  const entries = Object.entries(pairs).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return '';
  const inner = entries
    .map(([k, v]) => `${indent}    <datum:${k}>${esc(v)}</datum:${k}>`)
    .join('\n');
  return `\n${indent}  <extensions>\n${inner}\n${indent}  </extensions>`;
}

function waypointXml(wp, opts) {
  const lat = num(wp.lat);
  const lng = num(wp.lng);
  if (lat == null || lng == null) return '';
  const time = opts.includeTimestamps ? iso(wp.createdAt) : null;
  const sym = SYM_BY_ICON_TYPE[wp.iconType] || SYM_BY_ICON_TYPE.flag;
  // Order is not cosmetic. wptType is an xsd:sequence, so a schema-validating
  // reader rejects the element if these appear out of order. The sequence is
  // ele, time, magvar, geoidheight, name, cmt, desc, src, link, sym, type,
  // ... , extensions. Hence time before name, and extensions strictly last.
  const parts = [
    time ? `    <time>${time}</time>` : '',
    wp.name ? `    <name>${esc(wp.name)}</name>` : '',
    wp.notes ? `    <desc>${esc(wp.notes)}</desc>` : '',
    `    <sym>${esc(sym)}</sym>`
  ].filter(Boolean).join('\n');
  const ext = extensionsBlock({
    id: wp.id,
    iconType: wp.iconType,
    boundRouteId: wp.boundRouteId,
    routeDistance: wp.routeDistance
  }, '  ', opts.includeDatumExtensions);
  return `  <wpt lat="${lat}" lon="${lng}">\n${parts}${ext}\n  </wpt>`;
}

function routeXml(route, opts) {
  const pts = (route.points || [])
    .filter(p => num(p.lat) != null && num(p.lng) != null)
    .map(p => `    <rtept lat="${num(p.lat)}" lon="${num(p.lng)}"></rtept>`)
    .join('\n');
  // rteType has NO <time> element. Writing one produced a file that lenient
  // parsers tolerated and strict ones rejected, so the creation time goes in
  // extensions instead. Sequence here is name, cmt, desc, src, link, number,
  // type, extensions, rtept: extensions BEFORE the points, unlike wptType
  // where it comes last.
  const head = route.name ? `    <name>${esc(route.name)}</name>` : '';
  const ext = extensionsBlock({
    id: route.id,
    createdAt: opts.includeTimestamps ? iso(route.createdAt) : null
  }, '  ', opts.includeDatumExtensions);
  return `  <rte>\n${head ? head + '\n' : ''}${ext ? ext.trimStart() + '\n' : ''}${pts}\n  </rte>`;
}

function trackXml(track, opts) {
  let points = (track.points || []).filter(p => num(p.lat) != null && num(p.lng) != null);
  if (opts.trimStartMetres || opts.trimEndMetres) {
    points = trimTrackEnds(points, opts.trimStartMetres, opts.trimEndMetres);
  }
  if (!points.length) return '';

  const pts = points.map((p) => {
    const ele = num(p.altitude);
    const t = opts.includeTimestamps ? iso(p.timestamp) : null;
    const inner = [
      ele != null ? `<ele>${ele}</ele>` : '',
      t ? `<time>${t}</time>` : ''
    ].filter(Boolean).join('');
    return `      <trkpt lat="${num(p.lat)}" lon="${num(p.lng)}">${inner}</trkpt>`;
  }).join('\n');

  // trkType has no <time> either. Per-point times inside <trkpt> are the
  // schema-legal place for timing, and those are already written above.
  const head = track.name ? `    <name>${esc(track.name)}</name>` : '';
  const ext = extensionsBlock({
    id: track.id,
    startedAt: opts.includeTimestamps ? iso(track.startedAt) : null,
    endedAt: opts.includeTimestamps ? iso(track.endedAt) : null,
    trimmedMetres: opts.trimEndsMetres || null
  }, '  ', opts.includeDatumExtensions);
  return `  <trk>\n${head ? head + '\n' : ''}${ext ? ext.trimStart() + '\n' : ''}    <trkseg>\n${pts}\n    </trkseg>\n  </trk>`;
}

/**
 * Builds a GPX 1.1 document from any combination of Datum records.
 *
 * options.includeTimestamps  default true. False strips every <time>.
 * options.trimEndsMetres     default 0. Metres of travel to drop from each end
 *                            of every track.
 */
export function buildGpx({ name, waypoints = [], routes = [], tracks = [] }, options = {}) {
  const opts = {
    includeTimestamps: options.includeTimestamps !== false,
    trimStartMetres: options.trimStartMetres || 0,
    trimEndMetres: options.trimEndMetres || 0,
    // Kept as a parameter for tests and future callers, but no longer exposed
    // as a user option. Extensions in a foreign namespace are explicitly
    // permitted by the GPX schema and Garmin's own files use them the same
    // way, so a conforming reader ignores them. Turning them off only ever
    // cost Datum-to-Datum fidelity without buying any compatibility.
    includeDatumExtensions: options.includeDatumExtensions !== false
  };
  const body = [
    ...waypoints.map(w => waypointXml(w, opts)),
    ...routes.map(r => routeXml(r, opts)),
    ...tracks.map(t => trackXml(t, opts))
  ].filter(Boolean).join('\n');

  const meta = [
    name ? `    <name>${esc(name)}</name>` : '',
    // The document's own creation time is not a location disclosure, so it is
    // kept even when point timestamps are stripped. Readers use it to sort.
    `    <time>${new Date().toISOString()}</time>`
  ].filter(Boolean).join('\n');

  // The datum namespace is only declared when something actually uses it. An
  // unused namespace declaration is harmless but makes a "plain GPX" export
  // look like it still carries app-specific baggage.
  const nsAttr = opts.includeDatumExtensions ? ` xmlns:datum="${DATUM_NS}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Datum" xmlns="${NS}"${nsAttr}>
  <metadata>
${meta}
  </metadata>
${body}
</gpx>`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Direct children only. getElementsByTagName searches all descendants, which
// is wrong at container level: a <trk> asked for its <name> would happily
// return the <name> of the first <trkpt> inside it, and asking a <trk> for
// <time> would return the first trackpoint's timestamp. Matching on localName
// rather than a namespaced lookup because files in the wild are inconsistent
// about declaring the GPX namespace, and rejecting those would fail on real
// files people actually have.
function childText(parent, tag) {
  const el = Array.from(parent.children).find(c => c.localName === tag);
  return el && el.textContent != null ? el.textContent.trim() : null;
}

// Only reads datum:* children of this element's own <extensions>, not a
// descendant's, so a track's extensions are never mistaken for a point's.
function datumExt(parent, key) {
  const ext = Array.from(parent.children).find(c => c.localName === 'extensions');
  if (!ext) return null;
  const hit = Array.from(ext.children).find(c => c.localName === key);
  return hit && hit.textContent != null ? hit.textContent.trim() : null;
}

function msFrom(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return isNaN(t) ? null : t;
}

/**
 * Parses a GPX document into Datum records. Returns
 * { waypoints, routes, tracks, errors }.
 *
 * Records carry a `sourceId` (from the datum:id extension) and waypoints carry
 * `sourceBoundRouteId`, but never a real `id`. These are the sender's
 * identifiers and are useless as database keys here: an imported file is often
 * a copy of something already present, so reusing them would silently
 * overwrite the local copy. They exist purely so the importer can rebuild
 * relationships *within one file*, by matching a waypoint's
 * sourceBoundRouteId against a route's sourceId and rewriting it to whatever
 * id that route is actually given on save.
 *
 * That is what keeps a shared route and its bound flags a working unit in
 * Datum while the same file stays a plain, standard GPX to everything else.
 */
export function parseGpx(xmlString) {
  const errors = [];
  const out = { waypoints: [], routes: [], tracks: [], errors };

  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  } catch (e) {
    errors.push(`Could not parse file: ${e.message}`);
    return out;
  }
  // DOMParser reports XML failures as a parsererror element rather than by
  // throwing, so this has to be checked explicitly.
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
    errors.push('File is not valid XML.');
    return out;
  }
  if (doc.documentElement.localName !== 'gpx') {
    errors.push('File is not a GPX document.');
    return out;
  }

  for (const el of Array.from(doc.getElementsByTagName('wpt'))) {
    const lat = num(el.getAttribute('lat'));
    const lng = num(el.getAttribute('lon'));
    if (lat == null || lng == null) { errors.push('Skipped a waypoint with no coordinates.'); continue; }
    const iconType = datumExt(el, 'iconType');
    out.waypoints.push({
      lat,
      lng,
      name: childText(el, 'name') || 'Imported flag',
      notes: childText(el, 'desc') || '',
      iconType: iconType || 'flag',
      createdAt: msFrom(childText(el, 'time')) || Date.now(),
      // Never a usable key here, only a link to be resolved against routes in
      // the same file. Left null so a record saved without remapping is
      // correctly unbound rather than pointing at a stranger's route id.
      boundRouteId: null,
      routeDistance: num(datumExt(el, 'routeDistance')),
      sourceId: datumExt(el, 'id'),
      sourceBoundRouteId: datumExt(el, 'boundRouteId')
    });
  }

  for (const el of Array.from(doc.getElementsByTagName('rte'))) {
    const points = Array.from(el.getElementsByTagName('rtept'))
      .map(p => ({ lat: num(p.getAttribute('lat')), lng: num(p.getAttribute('lon')) }))
      .filter(p => p.lat != null && p.lng != null);
    if (points.length < 2) { errors.push('Skipped a route with fewer than two points.'); continue; }
    out.routes.push({
      name: childText(el, 'name') || 'Imported route',
      points,
      // rteType has no <time>, so this lives in extensions. The childText
      // fallback reads files from earlier Datum builds that wrote one anyway.
      createdAt: msFrom(datumExt(el, 'createdAt')) || msFrom(childText(el, 'time')) || Date.now(),
      sourceId: datumExt(el, 'id')
    });
  }

  for (const el of Array.from(doc.getElementsByTagName('trk'))) {
    // Multi-segment tracks are flattened into one point list. Datum has no
    // segment concept, and dropping all but the first segment would silently
    // lose most of a track recorded with pauses.
    const points = [];
    for (const seg of Array.from(el.getElementsByTagName('trkseg'))) {
      for (const p of Array.from(seg.getElementsByTagName('trkpt'))) {
        const lat = num(p.getAttribute('lat'));
        const lng = num(p.getAttribute('lon'));
        if (lat == null || lng == null) continue;
        points.push({
          lat,
          lng,
          altitude: num(childText(p, 'ele')),
          timestamp: msFrom(childText(p, 'time'))
        });
      }
    }
    if (points.length < 2) { errors.push('Skipped a track with fewer than two points.'); continue; }
    const stamps = points.map(p => p.timestamp).filter(t => t != null);
    out.tracks.push({
      name: childText(el, 'name') || 'Imported track',
      points,
      startedAt: msFrom(datumExt(el, 'startedAt')) || (stamps.length ? Math.min(...stamps) : null),
      endedAt: msFrom(datumExt(el, 'endedAt')) || (stamps.length ? Math.max(...stamps) : null),
      createdAt: Date.now(),
      sourceId: datumExt(el, 'id')
    });
  }

  if (!out.waypoints.length && !out.routes.length && !out.tracks.length) {
    errors.push('No waypoints, routes or tracks found in this file.');
  }
  return out;
}
