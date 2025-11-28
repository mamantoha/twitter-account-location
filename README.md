<div align="center">
<img src="logo.svg" alt="logo" width="80" height="80"/>
<h1>Twitter Account Location</h1>
<h3>A browser extension that displays Account based location information next to Twitter/X usernames.
</h3>
</div>

> Note: This repository is a fork of https://github.com/RhysSullivan/twitter-account-location-in-username — "Twitter Account Location Flag".

> This fork targets Firefox as a WebExtension and uses `browser.*` APIs for compatibility.

## Features

- Automatically detects usernames on Twitter/X pages
- Queries Twitter's GraphQL API to get account location information
- Displays the account's provided location text next to usernames
- Works with dynamically loaded content (infinite scroll)
- Caches location data to minimize API calls

## Installation (Firefox)

1. Clone or download this repository.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...** and select the `manifest.json` file from this repository (or any file inside the extension directory).
4. The extension will be loaded temporarily and will remain active until Firefox is restarted.
5. For permanent distribution, package the extension as an XPI and follow MDN/Add-ons signing and distribution guides.

## How It Works

1. The extension runs a content script on all Twitter/X pages
2. It identifies username elements in tweets and user profiles
3. For each username, it queries Twitter's GraphQL API endpoint (`AboutAccountQuery`) to get the account's location
4. The location is displayed next to the username

## Files

- `manifest.json` - WebExtension manifest
- `content.js` - Main content script that processes the page and injects page scripts for API calls
- `README.md` - This file

## Technical Details

The extension uses a page script injection approach to make API requests. This allows it to:

- Access the same cookies and authentication as the logged-in user
- Make same-origin requests to Twitter's API without CORS issues
- Work seamlessly with Twitter's authentication system

The content script injects a script into the page context that listens for location fetch requests. When a username is detected, the content script sends a custom event to the page script, which makes the API request and returns the location data.

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

The response contains `account_based_in` field in:

```
data.user_result_by_screen_name.result.about_profile.account_based_in
```

## Limitations

- Requires the user to be logged into Twitter/X
- Only works for accounts that have location information available
- Location names are shown as returned by the API
- Rate limiting (50 requests per 15 minutes)

## Privacy

- The extension only queries public account information
- No data is stored or transmitted to third-party servers
- All API requests are made directly to Twitter/X servers
- Location data is cached locally using Firefox IndexedDB

## Troubleshooting

If locations are not appearing:

1. Make sure you're logged into Twitter/X
2. Check the browser console for any error messages
3. Verify that the account has location information available
4. Try refreshing the page

## License

MIT
