# Copilot Instructions for AI Coding Agents

## Project Overview
This is a browser extension for Twitter/X that displays account-based location information next to usernames. It works on both Firefox and Chrome, using content scripts and page script injection to fetch and display location data from Twitter's GraphQL API.

## Architecture & Key Components
- **src/content.js**: Main content script. Detects usernames, communicates with the injected page script, and updates the UI with location info.
- **src/pageScript.js**: Injected into the page context. Handles API requests to Twitter's GraphQL endpoint using the user's authentication/cookies.
- **src/cacheManager.js**: Validates and caches account responses in IndexedDB for 30 days, or one day for confirmed missing accounts. Prunes stale entries in a single transaction.
- **src/requestCoordinator.js**: Owns the shared queue, persistence, execution leases, cancellation, and rate-limit backoff. Uses alarms to resume after background suspension and delegates authenticated requests to ready X tabs.
- **src/background.js**: Enables the toolbar action on X tabs and asks content scripts to refresh the enabled setting when tabs change.
- **src/popup.js / src/popup.html**: Accessible extension controls, paginated/searchable cached profiles, and location statistics.
- **manifest.firefox.json / manifest.chrome.json**: Tracked browser-specific manifests. A root `manifest.json` is an ignored local copy used for development. Packaging copies the appropriate tracked manifest into an isolated build directory.

## Data Flow
1. **Detection**: `src/content.js` parses profile links on `https://x.com/*`, batches DOM mutations, and normalizes queue/cache keys to lowercase.
2. **Request**: Cache misses enter the background coordinator's shared serial queue. It delegates work to one ready tab, which communicates with `src/pageScript.js` through validated `window.postMessage` messages targeting the page origin.
3. **API Call**: `src/pageScript.js` captures authorization and CSRF headers from X's GraphQL traffic, queries `AboutAccountQuery`, and returns results and correlated rate-limit updates. Requests have readiness, fetch, and response timeouts.
4. **Caching**: Valid account and confirmed-missing results are cached via `src/cacheManager.js`; HTTP/GraphQL errors and malformed results are not cached. Writes resolve only after transaction completion.
5. **Display**: Location info is injected next to usernames in the UI.

## Developer Workflows
- **Build**: `make firefox`, `make chrome`, or `make -j all` creates ZIPs in `dist/build/`. `package.json` and both manifests must have matching versions; release tags must be `v<version>`. Building does not modify the local root manifest.
- **Manual Install**: Copy the matching browser manifest to `manifest.json`. Load it temporarily in Firefox via `about:debugging`, or use **Load unpacked** in Chrome via `chrome://extensions/`. Reload the extension and refresh X after edits; see README for exact steps.
- **Debugging**: Use browser console logs in Twitter/X pages. Check for errors in content/page scripts. IndexedDB can be inspected for cache issues.
- **Checks**: Run `npm install` and `npm run lint`. There is no automated test suite; follow README's manual verification checklist in both browsers.

## Project-Specific Patterns
- **API Integration**: All Twitter API calls are made from the injected page script (`src/pageScript.js`) to avoid CORS/auth issues.
- **Caching**: Expiration is checked on reads; popup scans also prune expired/invalid entries. Confirmed missing accounts complete pending work without displaying a location label.
- **Rate Limiting**: The queue uses response headers rather than a fixed allowance, waits 200 ms between requests, and uses a two-minute fallback when rate limited without a usable reset time. Queues/backoff are shared across X tabs and persisted by a single background writer. Alarms restore scheduling after worker suspension; an active execution lease survives worker restarts.
- **Enabled State and Clearing**: The enabled setting syncs through storage changes. Disabling cancels active work and retains pending usernames. Clearing increments a persisted shared generation, settles pending callers in every X tab, and skips currently visible containers until reload/replacement.

## External Dependencies
- No third-party runtime libraries; ESLint is a development dependency.
- Relies on X's website GraphQL endpoint, the logged-in session, browser IndexedDB, and extension local storage. The configured endpoint and response shape may change.

## Example Patterns
- **Page Communication**: Source/origin, payload, and active-request checks constrain `postMessage` traffic but do not authenticate scripts running on the same page. Do not treat the shared page context as a trusted extension context.
- **IndexedDB Usage**: `cacheManager.js` provides a simple pattern for storing and expiring cached data.

## Key Files
- `src/content.js`, `src/requestCoordinator.js`, `src/pageScript.js`, `src/cacheManager.js`, `manifest.*.json`, `Makefile`, `README.md`

---

For questions or unclear patterns, review the README or open an issue. Please update this file if new workflows or architectural changes are introduced.
