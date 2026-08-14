# Bug Bounty Toolkit - Android / Termux

A practical bug bounty toolkit built for Android. No desktop, no Kali, no laptop required. Everything runs from Termux on your phone.

---

## Guides

### [Termux Installation Guide](toolkit_main.md)
Tool installation and usage for Termux on Android.

- Initial setup
- Subfinder - subdomain enumeration
- httpx - HTTP probing and fingerprinting
- Nuclei - template-based vulnerability scanning
- Dalfox - XSS scanning and parameter analysis
- ffuf - endpoint, directory, and parameter fuzzing
- PATH reference and tool verification

---

### [Traffic Interception and Token Refresh](toolkit_auth_reqable.md)
HTTPS traffic interception on Android and automated token management for authenticated testing.

- Reqable setup - CA certificate installation and Firefox Nightly configuration
- How to identify your target's auth pattern
- Pattern 1: JSON body refresh
- Pattern 2: Cookie-based refresh
- Pattern 3: Bearer token in Authorization header
- Pattern 4: OAuth2 grant_type=refresh_token
- Pattern 5: Static API key
- Running refresh scripts in the background (nohup, tmux)
- Reading tokens in other tools
- Decoding JWT tokens without external libraries

---

## Requirements

- Android phone
- [Termux](https://f-droid.org/packages/com.termux/) - install from F-Droid, not the Play Store version
- [Reqable](https://play.google.com/store/apps/details?id=com.reqable.android) - from Play Store
- [Firefox Nightly](https://play.google.com/store/apps/details?id=org.mozilla.fenix) - from Play Store
