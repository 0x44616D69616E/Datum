#!/usr/bin/env node
/**
 * Configures release signing in the generated build.gradle.
 *
 * Without this, `gradlew assembleRelease` produces an unsigned APK and
 * `assembleDebug` produces one signed with Android's debug key, which ships
 * with the SDK and is identical on every machine on earth. Anything signed
 * with it can be replaced by anyone, so a debug-signed release is not
 * meaningfully signed at all.
 *
 * Credentials come from keystore.properties in the project root, which is
 * gitignored. The keystore itself lives outside the repository entirely.
 * Neither is ever committed, which is why this generates the configuration at
 * build time rather than storing it.
 *
 * If keystore.properties is absent the script exits quietly and leaves the
 * project unsigned. That is deliberate: F-Droid builds from a clean clone and
 * has no access to the keystore, so a hard failure there would break their
 * build for no reason. They sign with their own key and then verify the
 * result matches the APK signed with this one.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const propsPath = path.join(root, 'keystore.properties');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');

if (!fs.existsSync(gradlePath)) {
  console.log('No android/app/build.gradle yet, skipping signing config.');
  process.exit(0);
}
if (!fs.existsSync(propsPath)) {
  console.log('No keystore.properties, leaving the project unsigned (expected on a build server).');
  process.exit(0);
}

let gradle = fs.readFileSync(gradlePath, 'utf8');

if (gradle.includes('signingConfigs')) {
  console.log('Signing config already present, nothing to do.');
  process.exit(0);
}

// Read at configuration time from a file outside version control, so the
// password never appears in the build script or in any committed file.
const loader = `
def keystorePropertiesFile = rootProject.file("../keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }
}
`;

// Inserted immediately after the apply plugin line, which is the only place
// that works. Two failures got us here:
//
//   Appended at the end, Gradle evaluated the buildTypes reference to
//   signingConfigs.release before the block defining it, and failed with
//   "Could not get unknown property 'release'".
//
//   Prepended at the top, the android {} block came before the plugin that
//   defines it, and failed with "Could not find method android()".
//
// So it has to sit after the plugin is applied and before buildTypes runs.
const applyMatch = /^apply plugin: ['"]com\.android\.application['"].*$/m.exec(gradle);
if (!applyMatch) {
  console.error('Could not find the com.android.application plugin line to anchor the signing config to.');
  process.exit(1);
}
const insertAt = applyMatch.index + applyMatch[0].length;
gradle = gradle.slice(0, insertAt) + '\n' + loader + gradle.slice(insertAt);

// Point the release build type at the config now that it is defined above it.
const before = gradle;
gradle = gradle.replace(
  /(buildTypes\s*\{[\s\S]*?release\s*\{)/,
  '$1\n            signingConfig signingConfigs.release'
);
if (gradle === before) {
  console.error('Could not find a release build type to attach the signing config to.');
  process.exit(1);
}

fs.writeFileSync(gradlePath, gradle);
console.log('Release signing configured from keystore.properties.');
