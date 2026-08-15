#!/usr/bin/env node
/**
 * Takes a clean checkout to a buildable Android project.
 *
 * The android/ directory is generated output, not source, so it is not in the
 * repository. That is deliberate: five scripts in this folder rewrite the
 * manifest and generate Java into it on every sync, so a committed copy would
 * be overwritten by the build and would drift silently out of step with what
 * the device actually produces.
 *
 * The consequence is that a fresh clone has no android/ at all, and anything
 * building this project (a new contributor, or F-Droid's build server) has to
 * create it first. This script is that step, and it is the only one needed:
 *
 *     npm ci && npm run build:android && cd android && ./gradlew assembleRelease
 *
 * Safe to run repeatedly. It adds the platform only when it is missing, and
 * every generator it calls is itself idempotent.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

// `npx cap add` fails outright if the platform already exists, so this is
// checked rather than attempted and caught: a failure here should be a real
// failure, not one this script routinely swallows.
if (!fs.existsSync(androidDir)) {
  console.log('No android/ directory, creating the platform.');
  run('npx cap add android');
} else {
  console.log('android/ already exists, skipping platform add.');
}

// Copies www/ into the platform and installs plugin dependencies. This also
// regenerates the manifest, which is why fix-manifest must follow it and not
// precede it.
run('npx cap sync android');

// Re-applies everything cap sync drops or never knew about: location and
// storage permissions, the three generated native plugins, the GPX file
// association, and the app name and launcher icon.
run('npm run fix-manifest');

console.log('\nAndroid project ready. Build with:\n  cd android && ./gradlew assembleRelease\n');
