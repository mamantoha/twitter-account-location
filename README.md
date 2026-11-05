# Twitter Account Location

A browser extension that displays account-based location information next to Twitter/X usernames.

[![Firefox Add-on](https://img.shields.io/amo/v/twitter-account-location?label=Firefox%20Add-on)](https://addons.mozilla.org/uk/firefox/addon/twitter-account-location/)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/mhfejoclbhjgkhmlapfhgpepdmnmanhi?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/twitter-account-location/mhfejoclbhjgkhmlapfhgpepdmnmanhi)
[![GitHub release](https://img.shields.io/github/release/mamantoha/twitter-account-location.svg)](https://github.com/mamantoha/twitter-account-location/releases)
[![License](https://img.shields.io/github/license/mamantoha/twitter-account-location.svg)](https://github.com/mamantoha/twitter-account-location/blob/main/LICENSE)

![Screenshot of Twitter Account Location extension in action](assets/screenshot.png)

## Features

- Detects usernames on Twitter/X pages
- Queries Twitter's GraphQL API for location info
- Displays location next to usernames
- Works with infinite scroll
- Caches valid account results for 30 days and confirmed missing accounts for one day
- Provides searchable cached profiles, 100 profiles per page, and location statistics
- Lets you enable or disable the extension and clear pending requests from the popup

## Installation

| Browser  | Method                | Link                                                                 |
|----------|-----------------------|----------------------------------------------------------------------|
| Firefox  | Add-on Store          | [Firefox Add-ons](https://addons.mozilla.org/uk/firefox/addon/twitter-account-location/) |
| Chrome   | Web Store             | [Chrome Web Store](https://chromewebstore.google.com/detail/twitter-account-location/mhfejoclbhjgkhmlapfhgpepdmnmanhi) |
| Both     | Manual (ZIP)          | [GitHub Releases](https://github.com/mamantoha/twitter-account-location/releases)         |

### Manual Installation

Use a source checkout, or download a browser-specific ZIP from [GitHub Releases](https://github.com/mamantoha/twitter-account-location/releases) and extract it into a folder. Keep that folder while the extension is loaded.

#### Firefox

1. For a source checkout, create the local manifest from the repository folder:

   ```sh
   cp manifest.firefox.json manifest.json
   ```

   An extracted Firefox build already contains `manifest.json`.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...** and select `manifest.json` from the source checkout or extracted Firefox build.
4. Open or refresh `https://x.com` while logged in.

The extension is loaded temporarily and is removed when Firefox restarts.

#### Chrome

1. For a source checkout, create the local manifest from the repository folder:

   ```sh
   cp manifest.chrome.json manifest.json
   ```

   An extracted Chrome build already contains `manifest.json`.
2. In Chrome, open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Open or refresh `https://x.com` while logged in.

Each source checkout has one local `manifest.json`. To load both browser variants at once, use separate checkouts or extract each browser's build into its own folder.

## How It Works

1. The extension runs a content script on `https://x.com/*` pages.
2. It identifies username elements in tweets and user profiles.
3. It checks the local cache, then queues uncached usernames for X's `AboutAccountQuery` GraphQL endpoint.
4. The location is displayed next to the username. A valid account without a location displays **Unknown**; a confirmed missing account displays no label.

## Technical Details

- **Page Script Injection:** The extension injects a script into the page context to make API requests. This allows it to:

  - Access the same cookies and authentication as the logged-in user
  - Make same-origin requests to Twitter's API without CORS issues
  - Capture authorization and CSRF headers from X's own GraphQL requests

- **Content Script Communication:** The content script uses `window.postMessage` to request account data from the page script. Both sides check the message source, origin, and payload; responses and rate-limit updates are matched to the active request. Messages target X's exact origin. These checks do not authenticate other scripts running on the same X page.

- **Caching:** Valid account responses are reused from browser IndexedDB for 30 days; confirmed missing accounts are reused for one day. Expired or invalid entries are removed on lookup or when the popup loads its cache list. HTTP errors, GraphQL errors, and malformed responses are not cached.

- **Request Queue:** The background coordinator owns one queue per cookie store and private-browsing context. X tabs in the same Firefox container share a queue; different containers have independent queues and rate limits. Each queue runs one account request at a time with a 200 ms pause between requests. Providers and result broadcasts stay within that context, matching its separate cache store. Response headers control shared backoff; a rate-limited response without a usable future reset time triggers a two-minute fallback. Pending usernames, scheduling state, and rate-limit metadata are saved in extension local storage. The `alarms` permission lets the coordinator resume after background suspension. A persisted execution lease prevents immediate redispatch when the background restarts during a request. Pending lists from the earlier global-queue implementation are retained as a legacy backup; reloading X tabs rebuilds scoped queues from visible accounts.

- **Popup Controls:** The enabled setting applies across all containers: disabling cancels active requests, pauses pending work, and removes location labels; re-enabling resumes work. Queue counts, rate-limit information, and clearing use the active X tab's container. Clearing affects only that context's tabs and skips their currently displayed account containers until reload or replacement; existing location labels remain.

## API Endpoint

The endpoint currently configured in `src/pageScript.js` is:

```
https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery
```

With variables:

```json
{
  "screenName": "username"
}
```

The response contains the `account_based_in` field in:

```
data.user_result_by_screen_name.result.about_profile.account_based_in
```

## Limitations

- Requires the user to be logged into Twitter/X.
- Requires X to make an authenticated GraphQL request after the page script loads so authorization and CSRF headers can be captured.
- Location names are shown as returned by the API.
- The endpoint and response structure are hard-coded and may need updates when X changes its API.
- The popup shows the latest observed rate-limit headers; the extension does not assume a fixed request allowance.
- Queued work needs a ready, logged-in X tab in the same cookie store and private-browsing context to execute requests. Closing the executing tab can delay failover until its execution lease expires.

## Privacy

- Account queries go directly to `x.com` using the logged-in session.
- Account responses are cached in browser IndexedDB. The enabled setting, pending usernames, and request scheduling/rate-limit metadata are stored in extension local storage.
- Profile images are loaded from avatar URLs returned in account responses.
- The extension has no analytics or separate backend.

## Troubleshooting

If locations are not appearing:

1. Make sure you're logged into Twitter/X.
2. Verify that **Enable Extension** is on in the popup and check its action feedback.
3. Check the X page console for content/page-script errors. Inspect the extension through `about:debugging` in Firefox or `chrome://extensions/` in Chrome for popup/background errors.
4. Refresh X after loading or reloading the extension. If authentication headers are unavailable, interact with X so it makes its own GraphQL requests, then reload the page if needed.
5. If rate limited, wait until the reset time shown in the popup. Reopen the popup to see updated information.

For more help, see [Support](#support).

---

## Building

Run `make firefox` or `make chrome` to create a ZIP in `dist/build/`, or `make -j all` to build both in parallel. Building requires Node.js, Make, and `zip`.

`package.json` defines the archive version. Both browser manifests must match it. Release tags must use `v<version>` (for example, `v1.1.3`); check locally with `RELEASE_TAG=v1.1.3 make check-version`.

Builds use separate temporary directories and do not modify a local `manifest.json`.

## Local Development

Install the lint dependency and run the existing check:

```sh
npm install
npm run lint
```

Load a source checkout using the browser-specific installation steps above. After editing source files:

- **Firefox:** Click **Reload** beside the extension in `about:debugging`, then refresh the X tab.
- **Chrome:** Click the extension's reload button in `chrome://extensions/`, then refresh the X tab.

If you loaded an extracted ZIP, rebuild and extract the updated files before reloading that extension.

### Manual Verification

There is no automated test suite. Run `npm run lint` and check the affected behavior in Firefox and Chrome:

1. **Initial load and scrolling:** Visit X while logged in, then scroll to load more tweets or user cells. Locations should appear without duplicate labels or indefinitely waiting spinners. Hover a location to check its account tooltip.
2. **Requests and cache:** Open two X tabs in the same Firefox container (or the same regular Chrome session) and filter their Network panels for `AboutAccountQuery`. Requests should run one at a time across both tabs, and requesting the same uncached account should share one API result. Reload a page and confirm previously cached accounts do not trigger new account queries. Close the executing tab while another is ready and confirm pending work continues after failover.
3. **Popup:** Confirm the count matches the loaded cache, search by username and location, and check statistics. With more than 100 entries, navigate profile pages and verify search includes accounts on other pages. Delete a profile and confirm the list and count update.
4. **Keyboard:** Use Tab to reach the switch, search, tabs, and buttons. Toggle with Space or Enter; move between the Profiles and Stats tabs with Left/Right, Home, and End. Check visible focus indicators and action feedback.
5. **Disable and resume:** Disable while requests are pending. Labels and spinners should disappear and new queued requests should stop. Re-enable and confirm pending work resumes. Check that another open X tab also observes the enabled setting.
6. **Clear queue:** Clear pending work from the popup. Confirm both tabs in that container show an empty shared queue with no stuck spinners or immediate refilling from the same visible account containers. Existing completed labels should remain.
7. **Failures and rate limits:** When encountered, confirm network/authentication failures do not become cached results or permanently waiting spinners. For a rate-limited response, verify neither tab in the affected container starts new account requests before reset. Check that the pending queue and reset time survive background suspension and that work resumes afterward.
8. **Firefox containers:** Open X in a different container. Its requests, cached profiles, queue count, and rate limits should stay separate. Clearing or rate limiting one container must not clear or block another. Closing all X tabs in one container must not route its pending requests to another container.
9. **Packaging changes:** Run `make -j all`, extract both archives, and confirm each contains its matching browser manifest and loads in that browser.

## Contributing

Contributions are welcome! To contribute:

1. Fork the repository and create your branch from `main`.
2. Make your changes, run lint and the relevant manual checks, and use clear commit messages.
3. Open a pull request describing your changes.

For bug reports or feature requests, please use [GitHub Issues](https://github.com/mamantoha/twitter-account-location/issues).

---

## Support

For questions, suggestions, or help, please open an issue on the [GitHub Issues page](https://github.com/mamantoha/twitter-account-location/issues).

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
