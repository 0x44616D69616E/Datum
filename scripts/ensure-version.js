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
 *
 * Also writes .versioncode, a single-line committed file containing just
 * this packed integer. F-Droid's checkupdates never runs a build; it reads
 * the raw checkout at each tag, and android/app/build.gradle does not exist
 * there since it is generated output, never committed (see prepare-android.js
 * and package.json's build:android script). checkupdates supports pointing
 * UpdateCheckData at an arbitrary committed file instead of assuming
 * build.gradle, but its regex can only return a single capture group, and
 * that group cannot compute major*10000+minor*100+patch from a plain semver
 * string like "1.6.3" by regex alone. Writing the already-computed integer
 * to its own file sidesteps that: UpdateCheckData points at .versioncode for
 * the code half and package.json for the name half, neither needing math.
 *
 * Unlike the build.gradle write below, this one is unconditional and does
 * not require android/ to exist yet, since .versioncode has to be correct
 * and committed independent of whether anyone has ever run a build.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const versionCodePath = path.join(root, '.versioncode');

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

// Unconditional: this file is committed and has to be right regardless of
// whether android/ has ever been generated on this machine.
const versionCodeContent = `${versionCode}\n`;
if (!fs.existsSync(versionCodePath) || fs.readFileSync(versionCodePath, 'utf8') !== versionCodeContent) {
  fs.writeFileSync(versionCodePath, versionCodeContent);
  console.log(`.versioncode set to ${versionCode}.`);
} else {
  console.log(`.versioncode already at ${versionCode}.`);
}

// Everything below requires android/app/build.gradle, which only exists
// after a build has actually generated it.
if (!fs.existsSync(gradlePath)) {
  console.log('No android/app/build.gradle yet, skipping build.gradle sync.');
  process.exit(0);
}

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
