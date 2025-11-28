// This script runs in the page context to access cookies and make API calls
(function () {
  // Store headers from Twitter's own API calls
  let twitterHeaders = null;
  let headersReady = false;

  // Function to capture headers from a request
  function captureHeaders(headers) {
    if (!headers) return;

    const headerObj = {};
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        headerObj[key] = value;
      });
    } else if (headers instanceof Object) {
      // Copy all headers
      for (const [key, value] of Object.entries(headers)) {
        headerObj[key] = value;
      }
    }

    // Replace headers completely (don't merge) to ensure we get auth tokens
    twitterHeaders = headerObj;
    headersReady = true;
  }

  // Intercept fetch to capture Twitter's headers
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = args[0];
    const options = args[1] || {};

    // If it's a Twitter GraphQL API call, capture ALL headers
    if (typeof url === "string" && url.includes("x.com/i/api/graphql")) {
      if (options.headers) {
        captureHeaders(options.headers);
      }
    }

    return originalFetch.apply(this, args);
  };

  // Also intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._url && this._url.includes("x.com/i/api/graphql")) {
      const headers = {};
      // Try to get headers from setRequestHeader
      if (this._headers) {
        Object.assign(headers, this._headers);
      }
      captureHeaders(headers);
    }
    return originalXHRSend.apply(this, args);
  };

  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (!this._headers) this._headers = {};
    this._headers[header] = value;
    return originalSetRequestHeader.apply(this, [header, value]);
  };

  // Wait a bit for Twitter to make some API calls first
  setTimeout(() => {
    if (!headersReady) {
      console.log("No Twitter headers captured yet, using defaults");
      twitterHeaders = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      headersReady = true;
    }
  }, 3000);

  // Listen for fetch requests from content script via postMessage
  window.addEventListener("message", async function (event) {
    // Only accept messages from our extension
    if (event.data && event.data.type === "__fetchAboutAccountQuery") {
      const { screenName, requestId } = event.data;

      // --- Simple rate limit block ---
      window._aboutAccountRateLimitReset =
        window._aboutAccountRateLimitReset || 0;
      const nowSec = Math.floor(Date.now() / 1000);
      if (window._aboutAccountRateLimitReset > nowSec) {
        window.postMessage(
          {
            type: "__aboutAccountQueryResponse",
            screenName,
            account: null,
            requestId,
            isRateLimited: true,
          },
          "*"
        );
        return;
      }

      // Wait for headers to be ready
      if (!headersReady) {
        let waitCount = 0;
        while (!headersReady && waitCount < 30) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
      }

      try {
        const variables = JSON.stringify({ screenName });
        const url = `https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=${encodeURIComponent(
          variables
        )}`;

        // Use captured headers or minimal defaults
        const headers = twitterHeaders || {
          Accept: "application/json",
          "Content-Type": "application/json",
        };

        // Ensure credentials are included
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: headers,
          referrer: window.location.href,
          referrerPolicy: "origin-when-cross-origin",
        });

        const resetTime = response.headers.get("x-rate-limit-reset");
        const remaining = response.headers.get("x-rate-limit-remaining");
        const limit = response.headers.get("x-rate-limit-limit");

        window.postMessage(
          {
            type: "__rateLimitHeaders",
            limit: limit ? parseInt(limit) : null,
            remaining: remaining ? parseInt(remaining) : null,
            resetTime: resetTime ? parseInt(resetTime) : null,
            waitTime: resetTime
              ? Math.max(0, parseInt(resetTime) * 1000 - Date.now())
              : null,
          },
          "*"
        );

        if (response.ok) {
          const data = await response.json();

          window.postMessage(
            {
              type: "__aboutAccountQueryResponse",
              screenName,
              account: data || null,
              requestId,
              isRateLimited: false,
            },
            "*"
          );
          return;
        } else {
          const errorText = await response.text().catch(() => "");

          // Handle rate limiting
          if (response.status === 429) {
            if (resetTime) {
              window._aboutAccountRateLimitReset = parseInt(resetTime);
              const resetDate = new Date(parseInt(resetTime) * 1000);
              const now = Date.now();
              const waitTime = resetDate.getTime() - now;

              console.log(
                `Rate limit resets at: ${resetDate.toLocaleString()}`
              );
              console.log(
                `Waiting ${Math.ceil(
                  waitTime / 1000 / 60
                )} minutes before retrying...`
              );

              // Store rate limit info for content script
              window.postMessage(
                {
                  type: "__rateLimitInfo",
                  resetTime: parseInt(resetTime),
                  waitTime: Math.max(0, waitTime),
                },
                "*"
              );
            }
          } else {
            console.log(
              `Twitter API error for ${screenName}:`,
              response.status,
              response.statusText,
              errorText.substring(0, 200)
            );
          }
        }

        // Send response back to content script via postMessage
        // Include error status so content script knows not to cache on rate limit
        window.postMessage(
          {
            type: "__aboutAccountQueryResponse",
            screenName,
            account: null,
            requestId,
            isRateLimited: response.status === 429,
          },
          "*"
        );
      } catch (error) {
        console.error("Error fetching location:", error);
        window.postMessage(
          {
            type: "__aboutAccountQueryResponse",
            screenName,
            account: null,
            requestId,
            isRateLimited: false,
          },
          "*"
        );
      }
    }
  });
})();
