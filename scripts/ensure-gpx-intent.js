// scripts/ensure-gpx-intent.js
//
// Registers Datum as an app Android offers when you tap a .gpx file, so a
// route someone emails you can be opened directly instead of being moved into
// Datum's own folder by hand with a separate file manager.
//
// Like the other scripts here, this is idempotent and safe to run after every
// `npx cap sync android`, which regenerates the native project and would
// otherwise drop the filter.
//
// Usage: node scripts/ensure-gpx-intent.js
// (or as part of: npm run fix-manifest)
//
// ---------------------------------------------------------------------------
// Why this is two filters with different shapes
// ---------------------------------------------------------------------------
//
// GPX has no single MIME type in practice. It is registered as both
// application/gpx+xml and application/octet-stream, and real senders disagree:
// mail clients tend to send application/gpx+xml, some map apps match on
// text/xml, and file managers commonly report an unrecognised extension as
// application/octet-stream.
//
// The two URI schemes need opposite matching strategies, which is the part
// that is easy to get wrong (and was, on the first attempt):
//
//   content:// carries NO filename in its path. A URI like
//   content://media/external/downloads/1000000042 has no ".gpx" anywhere in
//   it; the real name is resolved through the ContentResolver, which an
//   intent filter cannot consult. So a pathPattern on a content filter never
//   matches, and these must match on MIME type alone. Since file managers
//   send octet-stream for unknown extensions, that type has to be included,
//   which does mean Datum offers itself for some other unknown files. That is
//   the accepted cost of being openable at all, and it is what other GPX apps
//   do.
//
//   file:// does carry the path, so it can match by extension. But it has an
//   EMPTY authority (file:///storage/... has three slashes), and Android will
//   not match a filter that specifies a host against a URI that has none. So
//   these filters must omit android:host entirely.
//
// One further trap: pathPattern is greedy and restarts badly. ".*\\.gpx"
// gives up at the first dot in the path, so a file at /storage/.trash/x.gpx
// never matches. The documented workaround is to repeat the pattern with
// escalating ".*\\." prefixes, which is why each appears several times.
//
// Omitting mimeType entirely would break a filter, and omitting scheme, host
// and path together would make it match EVERYTHING, which is how an app ends
// up offering to open contacts and photos.

const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

// Marker comment so the block can be found and replaced rather than
// accumulating a fresh copy on every run.
const START = '<!-- datum-gpx-intent-start -->';
const END = '<!-- datum-gpx-intent-end -->';

// Matched on type alone for content://, which cannot be filtered by name.
const CONTENT_MIME_TYPES = [
  'application/gpx+xml',
  'application/octet-stream',
  'application/xml',
  'text/xml'
];

// file:// can be filtered by extension, so it accepts any type.
const FILE_MIME_TYPES = ['*/*'];

// One entry per leading-dot depth, per the pathPattern limitation above.
const PATH_PATTERNS = [
  '.*\\\\.gpx',
  '.*\\\\..*\\\\.gpx',
  '.*\\\\..*\\\\..*\\\\.gpx',
  '.*\\\\..*\\\\..*\\\\..*\\\\.gpx'
];

function buildIntentFilter() {
  const contentTags = CONTENT_MIME_TYPES.map(mime =>
    `                <data android:scheme="content" android:mimeType="${mime}" />`
  );

  const fileTags = [];
  for (const mime of FILE_MIME_TYPES) {
    for (const pattern of PATH_PATTERNS) {
      // No android:host. A file URI has an empty authority, and a filter that
      // names a host will not match a URI that has none.
      fileTags.push(
        `                <data android:scheme="file" android:mimeType="${mime}" android:pathPattern="${pattern}" />`
      );
    }
  }

  return `        ${START}
        <intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
${contentTags.join('\n')}
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
${fileTags.join('\n')}
        </intent-filter>
        ${END}`;
}

if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest not found at ${manifestPath} - run "npx cap add android" first.`);
  process.exit(1);
}

let manifest = fs.readFileSync(manifestPath, 'utf8');
const block = buildIntentFilter();

const startIdx = manifest.indexOf(START);
const endIdx = manifest.indexOf(END);

if (startIdx !== -1 && endIdx !== -1) {
  const existing = manifest.slice(manifest.lastIndexOf('\n', startIdx) + 1, endIdx + END.length);
  if (existing.trim() === block.trim()) {
    console.log('GPX intent filter already present and current - nothing to do.');
    process.exit(0);
  }
  manifest = manifest.slice(0, manifest.lastIndexOf('\n', startIdx) + 1) + block + manifest.slice(endIdx + END.length);
  fs.writeFileSync(manifestPath, manifest);
  console.log('GPX intent filter updated.');
  process.exit(0);
}

// Inserted inside the launcher activity rather than at application level, so
// the incoming intent reaches the activity Capacitor is already running.
const launcherMatch = manifest.match(/<activity[^>]*android:name="[^"]*MainActivity"[\s\S]*?<\/activity>/);
if (!launcherMatch) {
  console.error('Could not find MainActivity in the manifest - not modifying it.');
  process.exit(1);
}

const activityBlock = launcherMatch[0];
const insertAt = activityBlock.lastIndexOf('</activity>');
const updatedActivity = activityBlock.slice(0, insertAt) + block + '\n        ' + activityBlock.slice(insertAt);

manifest = manifest.replace(activityBlock, updatedActivity);
fs.writeFileSync(manifestPath, manifest);
console.log(`GPX intent filter added (${CONTENT_MIME_TYPES.length} content types, ${PATH_PATTERNS.length} file path patterns).`);
