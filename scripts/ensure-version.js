#!/usr/bin/env node
/**
 * Writes the version from package.json into the generated build.gradle.
 *
 * `npx cap add android` generates build.gradle with Capacitor's defaults,
 * versionCode 1 and versionName "1.0", and nothing updates them afterwards.
 * On a device that goes unnoticed, because the android/ directory is created
 * once and then hand-edited or simply ignored. It matters for two reasons:
 *
 *   F-Droid compares the built APK's versionCode against the number in its
 *   metadata and rejects a mismatch, so a build that always reports 1 can
 *   never be accepted.
 *
 *   Android refuses to install an APK whose versionCode is not greater than
 *   the installed one, so every release reporting 1 means users cannot
 *   update, only uninstall and reinstall.
 *
 * package.json is the single source of truth. A release changes the version
 * there and this derives both Android values from it, so the two cannot drift.
 *
 * versionCode is an integer and must always increase, so semver is packed as
 * major * 10000 + minor * 100 + patch. 1.6.1 becomes 10601. That allows 99
 * minor and 99 patch releases per major, and stays comfortably inside
 * Android's limit of 2100000000.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');

if (!fs.existsSync(gradlePath)) {
  console.log('No android/app/build.gradle yet, skipping version sync.');
  process.exit(0);
}

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Anything beyond major.minor.patch (a prerelease or build suffix) has no
// place in an Android versionCode, so it is deliberately not accepted rather
// than silently truncated into a number that means something else.
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!m) {
  console.error(`package.json version "${version}" is not major.minor.patch, refusing to guess a versionCode.`);
  process.exit(1);
}
const [, major, minor, patch] = m.map(Number);
if (minor > 99 || patch > 99) {
  console.error(`Version ${version} would collide in the packed versionCode scheme (minor and patch cap at 99).`);
  process.exit(1);
}
const versionCode = major * 10000 + minor * 100 + patch;

let gradle = fs.readFileSync(gradlePath, 'utf8');
const before = gradle;

gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);

if (gradle === before) {
  console.log(`build.gradle already at ${version} (${versionCode}).`);
} else {
  fs.writeFileSync(gradlePath, gradle);
  console.log(`build.gradle set to versionName "${version}", versionCode ${versionCode}.`);
}
