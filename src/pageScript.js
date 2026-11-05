// This script runs in the page context to access cookies and make API calls
(function () {
  // Store headers from Twitter's own API calls
  let twitterHeaders = null;
  let headersReady = false;
  const activeRequests = new Map();

  function isGraphQLRequest(input) {
    try {
      const url = new URL(input instanceof Request ? input.url : input, document.baseURI);
      return url.origin === window.location.origin && url.pathname.startsWith("/i/api/graphql/");
    } catch (error) {
      return false;
    }
  }

  // Keep the latest complete authentication headers; ignore incomplete requests.
  function captureHeaders(headers) {
    if (!headers) return;
    try {
      const normalized = new Headers(headers);
      if (!normalized.get("authorization") || !normalized.get("x-csrf-token")) return;
      twitterHeaders = Object.fromEntries(normalized.entries());
      if (!headersReady) {
        window.postMessage({ type: "__aboutAccountHeadersReady" }, window.location.origin);
      }
      headersReady = true;
    } catch (error) {
      // Header inspection must not prevent the page's original request.
    }
  }

  // Intercept fetch without changing its input or init overrides.
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const options = args[1] || {};
    if (isGraphQLRequest(input)) {
      captureHeaders(options.headers !== undefined
        ? options.headers
        : input instanceof Request ? input.headers : undefined);
    }
    return originalFetch.apply(this, args);
  };

  // Also intercept XMLHttpRequest, resetting captured headers when reused.
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const result = originalXHROpen.apply(this, [method, url, ...rest]);
    this._url = url;
    this._headers = new Headers();
    return result;
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isGraphQLRequest(this._url)) captureHeaders(this._headers);
    return originalXHRSend.apply(this, args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    const result = originalSetRequestHeader.apply(this, [header, value]);
    if (!this._headers) this._headers = new Headers();
    this._headers.append(header, value);
    return result;
  };

  function isValidRequestId(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
  }

  function readRateLimitHeader(response, name) {
    const raw = response.headers.get(name);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }

  // Listen for fetch requests from content script via postMessage
  window.addEventListener("message", async function (event) {
    if (event.source !== window || event.origin !== window.location.origin ||
        event.data === null || typeof event.data !== "object" || Array.isArray(event.data)) return;
    if (event.data?.type === "__cancelAboutAccountQuery") {
      if (isValidRequestId(event.data.requestId)) activeRequests.get(event.data.requestId)?.abort();
      return;
    }
    // Handle requests from the content script
    if (event.data && event.data.type === "__fetchAboutAccountQuery") {
      const { screenName, requestId } = event.data;
      if (typeof screenName !== "string" || !/^[a-zA-Z0-9_]{1,15}$/.test(screenName) ||
          !isValidRequestId(requestId) || activeRequests.has(requestId)) return;

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
          window.location.origin
        );
        return;
      }

      const controller = new AbortController();
      activeRequests.set(requestId, controller);

      // Wait for headers to be ready
      if (!headersReady) {
        let waitCount = 0;
        while (!headersReady && !controller.signal.aborted && waitCount < 30) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
      }

      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        controller.signal.throwIfAborted();
        if (!headersReady) {
          window.postMessage({
            type: "__aboutAccountQueryResponse",
            screenName,
            requestId,
            account: null,
            isRateLimited: false,
            error: "Authentication headers unavailable; reload X while logged in",
          }, window.location.origin);
          return;
        }
        const variables = JSON.stringify({ screenName });
        const url = `https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery?variables=${encodeURIComponent(
          variables
        )}`;

        const headers = twitterHeaders;

        // Ensure credentials are included
        const response = await fetch(url, {
          signal: controller.signal,
          method: "GET",
          credentials: "include",
          headers: headers,
          referrer: window.location.href,
          referrerPolicy: "origin-when-cross-origin",
        });

        const resetValue = readRateLimitHeader(response, "x-rate-limit-reset");
        const resetTime = resetValue !== null && resetValue <= Math.floor(Date.now() / 1000) + 86400
          ? resetValue : null;
        const remaining = readRateLimitHeader(response, "x-rate-limit-remaining");
        const limit = readRateLimitHeader(response, "x-rate-limit-limit");

        window.postMessage(
          {
            type: "__rateLimitHeaders",
            screenName,
            requestId,
            limit,
            remaining,
            resetTime,
            waitTime: resetTime
              ? Math.max(0, resetTime * 1000 - Date.now())
              : null,
          },
          window.location.origin
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
            window.location.origin
          );
          return;
        } else {
          await response.text().catch(() => "");

          // Handle rate limiting
          if (response.status === 429) {
            if (resetTime) {
              window._aboutAccountRateLimitReset = resetTime;
              const resetDate = new Date(resetTime * 1000);
              const now = Date.now();
              const waitTime = resetDate.getTime() - now;

              // Store rate limit info for content script, include remaining and limit
              window.postMessage(
                {
                  type: "__rateLimitInfo",
                  screenName,
                  requestId,
                  resetTime,
                  waitTime: Math.max(0, waitTime),
                  remaining,
                  limit,
                },
                window.location.origin
              );
            }
          } else {
            // do nothing
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
            error: response.status === 429 ? null : `Account request failed (HTTP ${response.status})`,
          },
          window.location.origin
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
            error: error.name === "AbortError" ? "Account fetch timed out" : "Account fetch failed",
          },
          window.location.origin
        );
      } finally {
        activeRequests.delete(requestId);
        clearTimeout(timeout);
      }
    }
  });
  window.postMessage({ type: "__aboutAccountQueryReady" }, window.location.origin);
})();
