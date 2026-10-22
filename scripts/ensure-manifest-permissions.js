// scripts/ensure-manifest-permissions.js
//
// `npx cap sync android` regenerates/touches the native Android project,
// and the location permissions have gotten silently lost more than once
// after that (especially if the android/ folder gets recreated rather than
// reused). This script is idempotent - safe to run after every single
// `cap sync android`, every time - it checks whether the permissions are
// already there and only inserts them if missing, so it never duplicates
// them either.
//
// Usage: node scripts/ensure-manifest-permissions.js
// (or: npm run fix-manifest)

const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

const REQUIRED_PERMISSIONS = [
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />'
];

// MANAGE_EXTERNAL_STORAGE ("All files access") used to be required here, for
// the old folder browser and file-import browser. Both were replaced by
// Android's own Storage Access Framework (see
// ensure-document-picker-plugin.js), which needs no special permission at
// all, so this script no longer adds it. An existing android/ built before
// that migration can still have the old line sitting in a manifest that was
// generated once and then hand-carried forward - REMOVED_PERMISSIONS strips
// it out on sync rather than leaving a stale, no-longer-justified permission
// declared for anyone who rebuilds without a totally clean android/.
const REMOVED_PERMISSIONS = [
  'android.permission.MANAGE_EXTERNAL_STORAGE'
];

if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest not found at ${manifestPath} - run "npx cap add android" first.`);
  process.exit(1);
}

let manifest = fs.readFileSync(manifestPath, 'utf8');
let changed = false;

for (const line of REQUIRED_PERMISSIONS) {
  // Match on the permission name rather than the exact line, so this still
  // catches it even if formatting/quoting differs slightly.
  const permName = line.match(/android:name="([^"]+)"/)[1];
  const alreadyPresent = manifest.includes(permName);

  if (!alreadyPresent) {
    manifest = manifest.replace(
      /<application/,
      `${line}\n\n    <application`
    );
    changed = true;
    console.log(`Added missing permission: ${permName}`);
  } else {
    console.log(`Already present: ${permName}`);
  }
}

for (const permName of REMOVED_PERMISSIONS) {
  const pattern = new RegExp(`\\s*<uses-permission[^>]*android:name="${permName}"[^>]*/>\\n?`, 'g');
  if (pattern.test(manifest)) {
    manifest = manifest.replace(pattern, '\n');
    changed = true;
    console.log(`Removed no-longer-needed permission: ${permName}`);
  }
}

if (changed) {
  fs.writeFileSync(manifestPath, manifest);
  console.log('Manifest updated.');
} else {
  console.log('Manifest already matched the required permission set - nothing to do.');
}
