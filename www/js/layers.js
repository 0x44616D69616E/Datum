// layers.js
// Registry of every available tile layer. This is the single source of
// truth both for what CAN be added to the map and for the default
// stack order - app.js builds the actual reorderable/opacity-controlled
// layer list from this at startup.
//
// Adding a new layer in the future = add one entry here. The layer
// manager UI, z-ordering, and opacity controls are all generic and don't
// need per-layer code elsewhere.

export const LAYER_SOURCES = {
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, Maxar, Earthstar Geographics',
    maxZoom: 18,
    downloadable: true // shows up as a choice in the offline region download flow
  },
  topo: {
    id: 'topo',
    label: 'Topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
    maxZoom: 17,
    downloadable: true
  },
  usgsTopo: {
    id: 'usgsTopo',
    label: 'USGS Topo',
    // USGS The National Map topographic basemap. Public domain, no API key.
    // Cached ArcGIS tile service, so the same reliable {z}/{y}/{x} ordering
    // as the satellite and BLM layers above, NOT the {z}/{x}/{y} that
    // OpenTopoMap and the OSM-derived layers use. Getting that backwards
    // returns tiles from the wrong place rather than failing outright.
    //
    // Contour units are NOT constant across zoom, which is the whole reason
    // this layer is worth having alongside OpenTopoMap. Per USGS: large-scale
    // US Topo quadrangle contours at 1:50,000 and larger, 50 ft intervals
    // from 1:50,000 to 1:150,000, and 100 ft from 1:150,000 to 1:600,000, so
    // everything at hiking zoom is in feet. Zoomed further out than
    // 1:600,000 it switches to 100 m contours. Contours are generated per
    // quadrangle, so lines can fail to meet across quad boundaries.
    //
    // maxNativeZoom is the real ceiling: USGS caches to roughly 1:9,000 and
    // has nothing beyond it. maxZoom is deliberately higher so that zooming
    // past the ceiling upscales the level-16 tiles instead of making the
    // layer disappear, which is what a bare maxZoom: 16 does. Blurry contours
    // are useful; a blank screen when you zoom in on your own position is not.
    //
    // Note this does NOT constrain the offline download flow. downloadRegion
    // clamps per layer using these same values, which is what keeps a z17+
    // request from queueing USGS tiles that can only 404.
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map (public domain)',
    maxNativeZoom: 16,
    maxZoom: 19,
    downloadable: true
  },
  trail: {
    id: 'trail',
    label: 'Trails',
    url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
    attribution: 'Waymarked Trails, OpenStreetMap contributors',
    maxZoom: 18,
    downloadable: true
  },
  landOwnership: {
    id: 'landOwnership',
    label: 'Public Land Ownership',
    // BLM Surface Management Agency - a proper CACHED tile service (same
    // simple, reliable {z}/{y}/{x} pattern as the satellite layer above),
    // not a fragile dynamic "export" request. Tells you specifically
    // BLM / Forest Service / State / Private - the actual access-legality
    // question - which is more directly useful than PAD-US's broader
    // "protected areas" framing for this use case.
    url: 'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_with_PriUnk/MapServer/tile/{z}/{y}/{x}',
    attribution: 'BLM Surface Management Agency (public domain)',
    maxZoom: 16,
    downloadable: true
  },
  weatherRadar: {
    id: 'weatherRadar',
    label: 'Weather Radar',
    // RainViewer - free, no API key. Handled entirely by radarPlayback.js,
    // NOT the generic offline tile cache: radar has multiple time frames,
    // and the same z/x/y tile means completely different imagery per
    // frame, so caching it under the generic layerId/z/x/y key would show
    // stale/wrong frames once playback switches frames. It's also
    // inherently live-only by nature - old radar tells you nothing, so
    // there's no real loss in it never being part of the offline
    // download flow.
    isRadarPlayback: true,
    attribution: 'RainViewer',
    downloadable: false
  },
  borders: {
    id: 'borders',
    label: 'Borders (states & countries)',
    // Not a tile source - real vector GeoJSON bundled directly in the app
    // (see boundariesLayer.js), so it works fully offline from first
    // launch with no download step. Still participates in the same
    // reorder/opacity/visibility system as every other layer.
    isVectorBorders: true,
    downloadable: false
  },
  streetLabels: {
    id: 'streetLabels',
    label: 'Street & Place Labels',
    // CartoDB's free "labels only" reference tiles - place names, roads,
    // borders as text/lines with a transparent background, meant to be
    // layered on top of satellite imagery so you get labels without a
    // full street basemap obscuring the photo. Free, no API key, but this
    // specific endpoint hasn't been independently verified the way the
    // other tile sources were - worth confirming it actually renders once
    // tested live.
    url: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    attribution: '© CARTO, © OpenStreetMap contributors',
    maxZoom: 19,
    downloadable: true
  }
};

// Default stack, top of array = rendered on top. Used to seed the very
// first launch; after that, the user's own order/visibility/opacity
// choices (persisted in localStorage) take over. This matches the
// "Damian's Hybrid" preset: public land ownership over satellite/trails/topo.
export const DEFAULT_LAYER_STACK = [
  { id: 'landOwnership', on: true, opacity: 0.6 },
  { id: 'weatherRadar', on: false, opacity: 0.75 },
  { id: 'borders', on: false, opacity: 0.8 },
  { id: 'streetLabels', on: false, opacity: 1 },
  { id: 'satellite', on: true, opacity: 0.4 },
  { id: 'trail', on: true, opacity: 1 },
  { id: 'topo', on: true, opacity: 1 },
  // Must be listed here, not only in LAYER_SOURCES: loadLayerStack()
  // reconciles a persisted stack against THIS array, so a layer absent from
  // it would never reach anyone who has already launched the app once.
  // Defaults to off so upgrading does not silently change an existing map.
  // Pushed to the end, which is the bottom of the stack, correct for a
  // basemap that other layers should draw over.
  { id: 'usgsTopo', on: false, opacity: 1 }
];

// Quick-apply shortcuts - still convenient even with full manual control
// available. These only touch visibility/opacity, not the manual order
// the user has set (order changes stay put unless the user drags things).
// Ordered full-stack presets. Unlike PRESETS above, which is an unordered map
// of layerId to {on, opacity} applied over whatever order the user currently
// has, these specify the stack itself, first entry drawn on top.
//
// Order matters here and cannot be expressed in the PRESETS form. The default
// stack puts landOwnership first, so BLM shading renders above everything;
// this configuration drops it below the trail and satellite layers, so the
// shading sits under them instead. At 0.49 opacity that is a visibly
// different map, and applying the same on/opacity values without the
// reordering produces something else entirely.
export const ORDERED_PRESETS = {
  usgsHybrid: {
    name: 'USGS hybrid',
    // Top of stack first: a light satellite wash over trails, over BLM
    // shading, over USGS Topo as the base. OpenTopoMap off, since usgsTopo
    // is doing that job and stacking both just muddies the contours.
    stack: [
      { id: 'weatherRadar', on: false, opacity: 0 },
      { id: 'borders', on: false, opacity: 0 },
      { id: 'streetLabels', on: false, opacity: 0 },
      { id: 'satellite', on: true, opacity: 0.26 },
      { id: 'trail', on: true, opacity: 1 },
      { id: 'landOwnership', on: true, opacity: 0.49 },
      { id: 'usgsTopo', on: true, opacity: 1 },
      { id: 'topo', on: false, opacity: 1 }
    ]
  }
};

export const PRESETS = {
  satelliteOnly: { satellite: { on: true, opacity: 1 }, topo: { on: false }, usgsTopo: { on: false }, trail: { on: false }, landOwnership: { on: false }, weatherRadar: { on: false }, borders: { on: false }, streetLabels: { on: false } },
  topoOnly: { satellite: { on: false }, topo: { on: true, opacity: 1 }, usgsTopo: { on: false }, trail: { on: false }, landOwnership: { on: false }, weatherRadar: { on: false }, borders: { on: false }, streetLabels: { on: false } },
  hybrid: { satellite: { on: true, opacity: 1 }, topo: { on: true, opacity: 0.5 }, usgsTopo: { on: false }, trail: { on: true, opacity: 1 }, landOwnership: { on: false }, weatherRadar: { on: false }, borders: { on: false }, streetLabels: { on: false } }
};
