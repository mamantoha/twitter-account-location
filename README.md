<div align="center">
  <img src="assets/logo.svg" alt="logo" width="80" height="80"/>
  <h1>Twitter Account Location</h1>
  <h3>A browser extension that displays account-based location information next to Twitter/X usernames.</h3>

  <p>
    <a href="https://addons.mozilla.org/uk/firefox/addon/twitter-account-location/"><img src="https://img.shields.io/amo/v/twitter-account-location?label=Firefox%20Add-on" alt="Get it on Firefox Add-ons"></a>
    <a href="https://github.com/mamantoha/twitter-account-location/releases"><img src="https://img.shields.io/github/release/mamantoha/twitter-account-location.svg" alt="GitHub release"></a>
    <a href="https://github.com/mamantoha/twitter-account-location/blob/main/LICENSE"><img src="https://img.shields.io/github/license/mamantoha/twitter-account-location.svg" alt="License"></a>
  </p>
</div>

---

# Table of Contents

- [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Installation](#installation)
    - [Firefox](#firefox)
      - [From Firefox Add-ons](#from-firefox-add-ons)
      - [Manual Installation](#manual-installation)
    - [Chrome](#chrome)
      - [Manual Installation](#manual-installation-1)
  - [How It Works](#how-it-works)
  - [Technical Details](#technical-details)
  - [API Endpoint](#api-endpoint)
  - [Limitations](#limitations)
  - [Privacy](#privacy)
  - [Troubleshooting](#troubleshooting)
  - [Contributing](#contributing)
  - [Support](#support)
  - [License](#license)

> **Note:** This project was originally forked from [RhysSullivan/twitter-account-location-in-username](https://github.com/RhysSullivan/twitter-account-location-in-username). It has since evolved to support both Firefox and Chrome, with additional features and improvements.

## Features

- Automatically detects usernames on Twitter/X pages
- Queries Twitter's GraphQL API to get account location information
- Displays the account's provided location text next to usernames
- Works with dynamically loaded content (infinite scroll)
- Caches location data to minimize API calls

## Installation

### Firefox

#### From Firefox Add-ons

1. Visit the [Firefox Add-ons page](https://addons.mozilla.org/uk/firefox/addon/twitter-account-location/).
2. Click **Add to Firefox** and follow the prompts.

#### Manual Installation

1. Clone or download this repository.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...** and select the `manifest.json` file from this repository (or any file inside the extension directory).
4. The extension will be loaded temporarily and will remain active until Firefox is restarted.

### Chrome

#### Manual Installation

1. Download the latest Chrome ZIP from the [GitHub Releases page](https://github.com/mamantoha/twitter-account-location/releases).
2. In Chrome, go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right).
4. Drag and drop the ZIP file onto the extensions page.
5. The extension will be installed and appear in your Chrome extensions list.
6. To update, remove the old version and repeat these steps with the new ZIP.

## How It Works

1. The extension runs a content script on all Twitter/X pages.
2. It identifies username elements in tweets and user profiles.
3. For each username, it queries Twitter's GraphQL API endpoint (`AboutAccountQuery`) to get the account's location.
4. The location is displayed next to the username, right in the UI.

## Technical Details

- **Page Script Injection:** The extension injects a script into the page context to make API requests. This allows it to:

  - Access the same cookies and authentication as the logged-in user
  - Make same-origin requests to Twitter's API without CORS issues
  - Work seamlessly with Twitter's authentication system

- **Content Script Communication:** The content script listens for location fetch requests. When a username is detected, it sends a custom event to the page script, which makes the API request and returns the location data.

- **Caching:** Location data is cached in your browser's IndexedDB and expires automatically after 30 days to minimize API calls and improve performance.

- **Files:**
  - `manifest.json` — WebExtension manifest
  - `content.js` — Main content script that processes the page and injects page scripts for API calls
  - `cacheManager.js` — Handles caching logic (IndexedDB)
  - `pageScript.js` — Injected script for API requests
  - `popup.html`, `popup.js` — Extension popup UI
  - `README.md` — This file

## API Endpoint

The extension uses Twitter's GraphQL API endpoint:

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
- Only works for accounts that have location information available.
- Location names are shown as returned by the API.
- Rate limiting: 50 requests per 15 minutes (extension will show a warning if limit is reached).

## Privacy

- The extension only queries public account information.
- No data is stored or transmitted to third-party servers.
- All API requests are made directly to Twitter/X servers.
- Location data is cached locally using Firefox IndexedDB and expires after 30 days.

## Troubleshooting

If locations are not appearing:

1. Make sure you're logged into Twitter/X.
2. Check the browser console for any error messages.
3. Verify that the account has location information available.
4. Try refreshing the page.
5. If you hit the rate limit, wait 15 minutes before trying again.

For more help, see [Support](#support).

---

## Contributing

Contributions are welcome! To contribute:

1. Fork the repository and create your branch from `main`.
2. Make your changes with clear commit messages.
3. Open a pull request describing your changes.

For bug reports or feature requests, please use [GitHub Issues](https://github.com/mamantoha/twitter-account-location/issues).

---

## Support

For questions, suggestions, or help, please open an issue on the [GitHub Issues page](https://github.com/mamantoha/twitter-account-location/issues).

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
