// Polyfill: use chrome if browser is undefined (for Chrome compatibility)
if (typeof browser === "undefined") {
  var browser = chrome;
}
// Common routes to exclude from username extraction
const EXCLUDED_ROUTES = [
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "compose",
  "search",
  "settings",
  "bookmarks",
  "lists",
  "communities",
  "hashtag",
];

// Rate limiting
const requestQueue = new Map(); // screenName => [{resolve, reject}]
let isProcessingQueue = false;
let rateLimitResetTime = 0; // Unix timestamp when rate limit resets
// Track in-flight network requests to avoid duplicate GraphQL calls for the same username
const inFlightRequests = new Map();

// Persisted queue (survives page reloads)
const PERSISTED_QUEUE_KEY = "pending_usernames_queue";
let persistedQueuedUsernames = new Set();
let persistedQueueSaveTimer = null;
let queueClearEpoch = 0;
let renderEpoch = 0;
let cancelActiveRequest = null;
const clearedContainers = new WeakSet();
let pageScriptReady = false;
let wakeRequestQueue = null;

// Store latest rate limit info
let latestRateLimitInfo = {
  limit: null,
  remaining: null,
  resetTime: null,
  waitTime: null,
};

// Observer for dynamically loaded content
let observer = null;
let contentScanTimer = null;
const USER_CONTAINER_SELECTOR = 'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="User-Names"], [data-testid="User-Name"]';
const LOCATION_UI_SELECTOR = '[data-twitter-location], [data-twitter-location-spinner], .twitter-location-tooltip, #twitter-location-spinner-style';

// Cached theme styles for tooltip performance
let cachedThemeStyles = null;
let themeObserver = null;
let themeDebounceTimer = null;

// Extension enabled state
let extensionEnabled = true;
const TOGGLE_KEY = "extension_enabled";
const DEFAULT_ENABLED = true;

function updateEnabledState(enabled) {
  const changed = extensionEnabled !== enabled;
  extensionEnabled = enabled;
  if (!enabled) {
    if (changed) renderEpoch += 1;
    for (const callbacks of requestQueue.values()) {
      callbacks.forEach(({ resolve }) => resolve(null));
      callbacks.length = 0;
    }
    if (cancelActiveRequest) cancelActiveRequest(true);
    if (wakeRequestQueue) wakeRequestQueue();
    removeAllLocations();
  } else if (changed && pageScriptReady) {
    processRequestQueue();
    processUsernames();
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[TOGGLE_KEY]) {
    updateEnabledState(changes[TOGGLE_KEY].newValue ?? DEFAULT_ENABLED);
  }
});

// Load enabled state
async function loadEnabledState() {
  try {
    const result = await browser.storage.local.get([TOGGLE_KEY]);
    updateEnabledState(
      result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED
    );
  } catch (error) {
    console.error("Error loading enabled state:", error);
    extensionEnabled = DEFAULT_ENABLED;
  }
}

function schedulePersistedQueueSave() {
  if (persistedQueueSaveTimer) {
    clearTimeout(persistedQueueSaveTimer);
  }

  persistedQueueSaveTimer = setTimeout(async () => {
    try {
      await browser.storage.local.set({
        [PERSISTED_QUEUE_KEY]: Array.from(persistedQueuedUsernames),
      });
    } catch (e) {
      // Ignore persistence errors
    }
  }, 250);
}

function addToPersistedQueue(screenName) {
  if (!screenName) return;
  persistedQueuedUsernames.add(screenName);
  schedulePersistedQueueSave();
}

function removeFromPersistedQueue(screenName) {
  if (!screenName) return;
  if (persistedQueuedUsernames.delete(screenName)) {
    schedulePersistedQueueSave();
  }
}

async function clearPersistedQueue() {
  queueClearEpoch += 1;
  renderEpoch += 1;
  document.querySelectorAll(USER_CONTAINER_SELECTOR).forEach((container) => {
    clearedContainers.add(container);
  });
  persistedQueuedUsernames.clear();
  for (const callbacks of requestQueue.values()) {
    callbacks.forEach(({ resolve }) => resolve(null));
  }
  requestQueue.clear();
  if (cancelActiveRequest) cancelActiveRequest();
  if (wakeRequestQueue) wakeRequestQueue();
  document.querySelectorAll("[data-twitter-location-spinner]").forEach((spinner) => spinner.remove());
  document.querySelectorAll("[data-location-waiting]").forEach((container) => {
    delete container.dataset.locationWaiting;
  });

  if (persistedQueueSaveTimer) {
    clearTimeout(persistedQueueSaveTimer);
    persistedQueueSaveTimer = null;
  }

  try {
    await browser.storage.local.set({ [PERSISTED_QUEUE_KEY]: [] });
  } catch (e) {
    // Ignore persistence errors
  }
}

async function restorePersistedQueue() {
  const restoreEpoch = queueClearEpoch;
  try {
    const result = await browser.storage.local.get([PERSISTED_QUEUE_KEY]);
    if (restoreEpoch !== queueClearEpoch) return;
    const list = Array.isArray(result[PERSISTED_QUEUE_KEY])
      ? result[PERSISTED_QUEUE_KEY]
      : [];

    persistedQueuedUsernames = new Set(
      list
        .filter((v) => typeof v === "string" && usernameFromHref(`/${v}`))
        .map((v) => v.toLowerCase())
    );

    // Drop items that are already cached
    if (typeof cacheManager !== "undefined") {
      for (const screenName of Array.from(persistedQueuedUsernames)) {
        const cached = await cacheManager.getValue(screenName);
        if (restoreEpoch !== queueClearEpoch) return;
        if (cached !== undefined) {
          // Valid account and confirmed-missing records both complete pending work.
          persistedQueuedUsernames.delete(screenName);
        }
      }
    }

    // Seed in-memory queue so future requests attach callbacks instead of duplicating
    for (const screenName of persistedQueuedUsernames) {
      if (!requestQueue.has(screenName)) {
        requestQueue.set(screenName, []);
      }
    }

    schedulePersistedQueueSave();

    if (persistedQueuedUsernames.size > 0) {
      processRequestQueue();
    }
  } catch (e) {
    // Ignore restore errors
  }
}

// Listen for toggle changes from popup
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "checkExtensionEnabled") {
    (async () => {
      await loadEnabledState();
      if (!extensionEnabled) {
        removeAllLocations();
      }
    })();
    return;
  }

  if (request.type === "getRateLimitInfo") {
    let queuedRequests = 0;
    for (const callbacks of requestQueue.values()) {
      queuedRequests += Array.isArray(callbacks) ? callbacks.length : 0;
    }

    sendResponse({
      ...latestRateLimitInfo,
      queueDistinct: requestQueue.size,
      queueRequests: queuedRequests,
      inFlight: inFlightRequests.size,
    });
    return true;
  } else if (request.type === "clearPersistedQueue") {
    (async () => {
      try {
        await clearPersistedQueue();
        sendResponse({ cleared: true });
      } catch (e) {
        sendResponse({ cleared: false });
      }
    })();
    return true;
  } else if (request.type === "extensionToggle") {
    updateEnabledState(request.enabled);
    return;
  } else if (request.type === "getAllCacheEntries") {
    (async () => {
      try {
        if (typeof cacheManager === "undefined" || !cacheManager.getAllEntries) {
          sendResponse({ error: "Unable to load cache entries" });
          return;
        }

        const extractAvatarUrl = (account) => {
          const url =
            account?.data?.user_result_by_screen_name?.result?.avatar?.image_url;
          if (typeof url === "string" && url.trim()) {
            // Prefer a slightly larger avatar for the popup
            return url.replace("_normal", "_bigger");
          }
          return null;
        };

        const extractLocationText = (account) => {
          const location =
            account?.data?.user_result_by_screen_name?.result?.about_profile
              ?.account_based_in;
          if (typeof location === "string" && location.trim()) {
            return location.trim();
          }
          return "Unknown";
        };

        const rawEntries = await cacheManager.getAllEntries({ pruneExpired: true });
        const entries = rawEntries.map((e) => ({
          username: e.username,
          cachedAt: e.cachedAt,
          location: extractLocationText(e.account),
          avatarUrl: extractAvatarUrl(e.account),
        }));

        sendResponse({ entries });
      } catch (e) {
        sendResponse({ error: "Unable to load cache entries" });
      }
    })();
    return true;
  } else if (request.type === "deleteCacheEntry") {
    (async () => {
      try {
        const username =
          typeof request.username === "string" ? request.username.trim() : "";
        if (!username) {
          sendResponse({ deleted: false });
          return;
        }

        if (typeof cacheManager === "undefined" || !cacheManager.deleteEntry) {
          sendResponse({ deleted: false });
          return;
        }

        await cacheManager.deleteEntry(username);
        sendResponse({ deleted: true });
      } catch (e) {
        sendResponse({ deleted: false });
      }
    })();
    return true;
  }
});

// Inject script into page context to access fetch with proper cookies
function injectPageScript() {
  const script = document.createElement("script");
  script.src = browser.runtime.getURL("src/pageScript.js");
  const ready = new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener("message", onReady);
      script.onerror = null;
      script.remove();
    };
    const onReady = (event) => {
      if (event.source !== window || event.data?.type !== "__aboutAccountQueryReady") return;
      cleanup();
      resolve();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Page script readiness timed out"));
    }, 5000);
    window.addEventListener("message", onReady);
    script.onerror = () => {
      cleanup();
      reject(new Error("Page script failed to load"));
    };
  });

  // Listen for rate limit info from page script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === "__rateLimitInfo") {
      // The page script may provide a resetTime (unix seconds)
      const providedReset = event.data.resetTime;
      // If reset time provided use it, otherwise fallback to 2 minutes
      if (providedReset && Number.isFinite(providedReset)) {
        rateLimitResetTime = providedReset;
      } else {
        rateLimitResetTime = Math.floor(Date.now() / 1000) + 120;
      }
      // Store extra info
      latestRateLimitInfo.limit = event.data.limit;
      latestRateLimitInfo.remaining = event.data.remaining;
      latestRateLimitInfo.resetTime = event.data.resetTime;
      latestRateLimitInfo.waitTime = event.data.waitTime;
    }
    // Optionally, listen for full rate limit info from page script
    if (event.data && event.data.type === "__rateLimitHeaders") {
      latestRateLimitInfo = {
        limit: event.data.limit,
        remaining: event.data.remaining,
        resetTime: event.data.resetTime,
        waitTime: event.data.waitTime,
      };
      if (event.data.remaining === 0) {
        const resetTime = event.data.resetTime;
        rateLimitResetTime = Number.isFinite(resetTime) && resetTime > Date.now() / 1000
          ? resetTime
          : Math.floor(Date.now() / 1000) + 120;
      }
    }
  });
  (document.head || document.documentElement).appendChild(script);
  return ready;
}

// Compute tooltip theme styles from current Twitter/X theme
function computeTooltipThemeStyles() {
  const parseRgb = (color) => {
    if (!color) return null;
    const match = color.match(
      /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/
    );
    if (!match) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    };
  };

  const isTransparent = (color) => {
    if (!color || color === "transparent") return true;
    const rgba = parseRgb(color);
    return rgba ? rgba.a === 0 : false;
  };

  const pickBackgroundColor = () => {
    const candidates = [
      document.querySelector('[data-testid="primaryColumn"]'),
      document.querySelector("main"),
      document.body,
      document.documentElement,
    ].filter(Boolean);

    for (const el of candidates) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && !isTransparent(bg)) return bg;
    }

    return "rgb(255, 255, 255)";
  };

  const backgroundColor = pickBackgroundColor();
  const textColor = getComputedStyle(document.body).color || "rgb(15, 20, 25)";

  const bg = parseRgb(backgroundColor);
  const text = parseRgb(textColor);

  const brightness = bg
    ? (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000
    : 255;
  const shadowAlpha = brightness > 180 ? 0.15 : 0.45;

  const borderColor = text
    ? `rgba(${text.r}, ${text.g}, ${text.b}, 0.2)`
    : "rgba(127, 127, 127, 0.3)";

  const accentColor =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-primary")
      .trim() || "#1d9bf0";

  return {
    backgroundColor,
    textColor,
    borderColor,
    boxShadow: `0 4px 32px rgba(0, 0, 0, ${shadowAlpha})`,
    accentColor,
  };
}

// Initialize and cache theme styles
function initializeThemeCache() {
  // Compute initial theme styles
  cachedThemeStyles = computeTooltipThemeStyles();

  // Set up observer to detect theme changes
  // Twitter/X typically changes theme by updating attributes on <html> or <body>
  // or by modifying CSS variables on :root
  if (themeObserver) {
    themeObserver.disconnect();
  }

  // Cache DOM references for performance
  const htmlElement = document.documentElement;
  const bodyElement = document.body;

  themeObserver = new MutationObserver((mutations) => {
    // Check if any mutations affect theme-related attributes or styles
    const themeChanged = mutations.some((mutation) => {
      // Check for attribute changes on html/body (e.g., data-theme, style, class)
      if (mutation.type === 'attributes' &&
          (mutation.target === htmlElement || mutation.target === bodyElement)) {
        return ['style', 'class', 'data-theme', 'data-color-mode'].includes(mutation.attributeName);
      }
      return false;
    });

    if (themeChanged) {
      // Debounce theme updates to avoid excessive recalculation
      if (themeDebounceTimer) {
        clearTimeout(themeDebounceTimer);
      }
      themeDebounceTimer = setTimeout(() => {
        cachedThemeStyles = computeTooltipThemeStyles();
      }, 100);
    }
  });

  // Observe both html and body for theme-related changes
  themeObserver.observe(htmlElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme', 'data-color-mode'],
  });

  themeObserver.observe(bodyElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme', 'data-color-mode'],
  });
}

// Process request queue with rate limiting
function waitForQueue(delay) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      wakeRequestQueue = null;
      resolve();
    }, delay);
    wakeRequestQueue = () => {
      clearTimeout(timeout);
      wakeRequestQueue = null;
      resolve();
    };
  });
}

async function processRequestQueue() {
  if (!pageScriptReady || !extensionEnabled || isProcessingQueue || requestQueue.size === 0) {
    return;
  }

  isProcessingQueue = true;

  try {
    while (extensionEnabled && requestQueue.size > 0) {
      // Re-check rate limit before starting each request.
      const waitTime = rateLimitResetTime * 1000 - Date.now();
      if (waitTime > 0) {
        await waitForQueue(Math.min(waitTime, 60000));
        continue;
      }
      rateLimitResetTime = 0;

      // Get the next screenName to process
      const screenName = requestQueue.keys().next().value;
      const callbacks = requestQueue.get(screenName);
      const requestEpoch = queueClearEpoch;

      // Remove from queue
      requestQueue.delete(screenName);

      try {
        const location = await makeAboutAccountQueryRequest(screenName);
        callbacks.forEach(({ resolve }) => resolve(location));
      } catch (error) {
        callbacks.forEach(({ reject }) => reject(error));
      }

      if (extensionEnabled && requestEpoch === queueClearEpoch) await waitForQueue(200);
    }
  } finally {
    isProcessingQueue = false;
  }
}

// Make actual API request
function makeAboutAccountQueryRequest(screenName) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random();
    const requestEpoch = queueClearEpoch;

    const cleanup = () => {
      window.removeEventListener("message", handler);
      clearTimeout(timeout);
      if (cancelActiveRequest === cancel) cancelActiveRequest = null;
    };
    const cancel = (retain = false) => {
      cleanup();
      if (retain && !requestQueue.has(screenName)) {
        requestQueue.set(screenName, []);
      }
      window.postMessage({ type: "__cancelAboutAccountQuery", requestId }, "*");
      resolve(null);
    };
    cancelActiveRequest = cancel;

    // Listen for response via postMessage
    const handler = async (event) => {
      // Only accept messages from the page (not from extension)
      if (event.source !== window) return;

      if (
        event.data &&
        event.data.type === "__aboutAccountQueryResponse" &&
        event.data.screenName === screenName &&
        event.data.requestId === requestId
      ) {
        cleanup();
        if (event.data.error) {
          reject(new Error(event.data.error));
          return;
        }
        const account = event.data.account;
        const isRateLimited = event.data.isRateLimited || false;

        // If the page signalled rate-limiting, trigger immediate backoff so we stop
        // sending further requests for a while. Do not cache rate-limited failures.
        if (isRateLimited) {
          // Fall back to two minutes if the response did not provide a future reset.
          if (rateLimitResetTime <= Date.now() / 1000) {
            rateLimitResetTime = Math.floor(Date.now() / 1000) + 120;
          }
          // Keep this username pending so it can be retried after reset.
          if (queueClearEpoch === requestEpoch) {
            addToPersistedQueue(screenName);
            if (!requestQueue.has(screenName)) {
              requestQueue.set(screenName, []);
            }
            processRequestQueue();
          }
        } else {
          const status = cacheManager.getAccountStatus(account);
          if (!status) {
            reject(new Error(`Invalid account response for ${screenName}`));
            return;
          }
          try {
            await cacheManager.saveCacheEntry(screenName, account);
            // Keep work pending if the result could not be persisted.
            removeFromPersistedQueue(screenName);
          } catch (error) {
            console.error("Error saving account result:", error);
          }
          resolve(status === "missing" ? null : account);
          return;
        }

        resolve(undefined);
      }
    };

    window.addEventListener("message", handler);
    const timeout = setTimeout(() => {
      cleanup();
      window.postMessage({ type: "__cancelAboutAccountQuery", requestId }, "*");
      reject(new Error(`Account request timed out for ${screenName}`));
    }, 15000);

    // Send fetch request to page script via postMessage
    window.postMessage(
      {
        type: "__fetchAboutAccountQuery",
        screenName,
        requestId,
      },
      "*"
    );
  });
}

// Function to query Twitter GraphQL API for user account info (with rate limiting)
async function getAboutAccount(screenName) {
  screenName = screenName.toLowerCase();
  // Check if there's already a request in progress for this username
  let promise = inFlightRequests.get(screenName);
  if (promise) {
    return promise;
  }

  // Create a new promise for this request
  promise = (async () => {
    const requestEpoch = queueClearEpoch;
    const requestRenderEpoch = renderEpoch;
    // Check cache first
    const data = await cacheManager.getValue(screenName);

    if (requestEpoch !== queueClearEpoch || requestRenderEpoch !== renderEpoch || !extensionEnabled) return null;

    if (data !== undefined) {
      return cacheManager.getAccountStatus(data.account) === "missing" ? null : data.account;
    }

    // Not cached, queue the API request
    return new Promise((resolve, reject) => {
      if (!requestQueue.has(screenName)) {
        requestQueue.set(screenName, []);
        addToPersistedQueue(screenName);
      }
      requestQueue.get(screenName).push({ resolve, reject });
      // If this is the first request for this screenName, start processing
      if (requestQueue.get(screenName).length === 1) {
        processRequestQueue();
      }
    });
  })();

  // Store the promise to prevent duplicate requests
  inFlightRequests.set(screenName, promise);

  // Clean up when the promise resolves
  const clearInFlight = () => {
    inFlightRequests.delete(screenName);
  };
  promise.then(clearInFlight, clearInFlight);

  return promise;
}

// Parse profile links without confusing route prefixes or tweet paths with handles.
function usernameFromHref(href) {
  if (typeof href !== "string") return null;
  const match = href.match(/^\/([a-zA-Z0-9_]{1,15})\/?(?:[?#].*)?$/);
  if (!match || EXCLUDED_ROUTES.includes(match[1].toLowerCase())) return null;
  return match[1];
}

// Function to extract username from various Twitter UI elements
function extractUsername(element) {
  const nameSelector = '[data-testid="UserName"], [data-testid="User-Name"]';
  const usernameElement = element.matches(`${nameSelector}, [data-testid="UserCell"]`)
    ? element
    : element.querySelector(nameSelector);

  if (usernameElement) {
    for (const link of usernameElement.querySelectorAll('a[href^="/"]')) {
      const username = usernameFromHref(link.getAttribute("href"));
      if (username) return username;
    }
  }

  for (const link of element.querySelectorAll('a[href^="/"]')) {
    const username = usernameFromHref(link.getAttribute("href"));
    if (!username) continue;
    const text = link.textContent?.trim().toLowerCase() || "";
    const normalized = username.toLowerCase();
    if (text === normalized || text === `@${normalized}`) return username;
  }
  return null;
}

// Helper function to find handle section
function findHandleSection(container, screenName) {
  const normalized = screenName.toLowerCase();
  return Array.from(container.querySelectorAll("div")).find((div) => {
    return Array.from(div.querySelectorAll('a[href^="/"]')).some((link) => {
      const username = usernameFromHref(link.getAttribute("href"));
      return username?.toLowerCase() === normalized &&
        link.textContent?.trim().toLowerCase() === `@${normalized}`;
    });
  });
}

// Create loading spinner placeholder
function createLoadingSpinner() {
  // Create a spinner element
  const spinner = document.createElement("span");
  spinner.setAttribute("data-twitter-location-spinner", "true");
  spinner.style.display = "inline-block";
  spinner.style.width = "16px";
  spinner.style.height = "16px";
  spinner.style.marginLeft = "4px";
  spinner.style.marginRight = "4px";
  spinner.style.verticalAlign = "middle";
  spinner.style.position = "relative";

  // Inner circle for spinner
  const circle = document.createElement("span");
  circle.style.boxSizing = "border-box";
  circle.style.display = "block";
  circle.style.width = "100%";
  circle.style.height = "100%";
  circle.style.border = "2px solid #1d9bf0";
  circle.style.borderTop = "2px solid transparent";
  circle.style.borderRadius = "50%";
  circle.style.animation = "twitter-location-spinner 0.8s linear infinite";

  spinner.appendChild(circle);

  // Add animation keyframes if not already added
  if (!document.getElementById("twitter-location-spinner-style")) {
    const style = document.createElement("style");
    style.id = "twitter-location-spinner-style";
    style.textContent = `
      @keyframes twitter-location-spinner {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  return spinner;
}

// Unified helper to insert spinner or location in the same spot
function insertElementNearHandle(container, screenName, element) {
  // Try to insert before handle section (preferred)
  const handleSection = findHandleSection(container, screenName);
  if (handleSection && handleSection.parentNode) {
    try {
      handleSection.parentNode.insertBefore(element, handleSection);
      return true;
    } catch (e) {
      // Fallback: insert at end of container
    }
  }
  // Fallback: insert at end of container
  try {
    container.appendChild(element);
    return true;
  } catch (e) {
    // Final fallback failed
    return false;
  }
}

// Function to add location to username element
async function addLocationToUsername(usernameElement, screenName) {
  if (!extensionEnabled || clearedContainers.has(usernameElement)) return;
  const requestRenderEpoch = renderEpoch;
  // Check if location already added
  if (usernameElement.dataset.locationAdded === "true") {
    return;
  }

  // If there's already an in-flight request for this username, mark this container
  // as waiting and return — the successful request will update waiting containers.
  if (inFlightRequests.has(screenName.toLowerCase())) {
    usernameElement.dataset.locationWaiting = "true";
    return;
  }

  // Find User-Name container for spinner/location placement
  let userNameContainer = usernameElement.querySelector(
    '[data-testid="UserName"], [data-testid="User-Name"]'
  );
  if (usernameElement.getAttribute("data-testid") === "UserCell") {
    userNameContainer = usernameElement;
  }

  // Create and insert loading spinner
  const spinnerSpan = createLoadingSpinner();
  let spinnerInserted = false;
  if (userNameContainer) {
    spinnerInserted = insertElementNearHandle(userNameContainer, screenName, spinnerSpan);
  }

  try {
    const account = await getAboutAccount(screenName);

    // Remove spinner
    if (spinnerInserted && spinnerSpan.parentNode) {
      spinnerSpan.remove();
    }

    if (!extensionEnabled || requestRenderEpoch !== renderEpoch) return;

    if (!account) {
      // Confirmed absence is complete; rate-limited requests remain retryable.
      if (account === null) usernameElement.dataset.locationAdded = "true";
      return;
    }

    const location = account?.data?.user_result_by_screen_name?.result?.about_profile?.account_based_in;
    const locationText = location && typeof location === "string" && location.trim() ? location.trim() : "Unknown";
    // Check if a location element already exists (check in the entire container)
    const existingLocation = usernameElement.querySelector(
      "[data-twitter-location]"
    );
    if (existingLocation) {
      usernameElement.dataset.locationAdded = "true";
      return;
    }

    // Add location text formatted as '🌐 Location' or '🌐 Unknown'
    const locationSpan = document.createElement("span");
    locationSpan.textContent = ` 🌐 ${locationText}`;
    locationSpan.setAttribute("data-twitter-location", "true");
    locationSpan.style.marginLeft = "4px";
    locationSpan.style.marginRight = "4px";
    locationSpan.style.display = "inline";
    locationSpan.style.color = "#1d9bf0"; // Twitter blue accent
    locationSpan.style.fontSize = "0.95em";
    locationSpan.style.fontWeight = "500";
    locationSpan.style.verticalAlign = "middle";
    locationSpan.style.whiteSpace = "nowrap";

    // Tooltip/modal logic with robust hover
    let tooltip = null;
    let hideTimeout = null;
    const showTooltip = () => {
      if (tooltip) return;
      const tooltipRenderEpoch = renderEpoch;
      (async () => {
        document.querySelectorAll('.twitter-location-tooltip').forEach((el) => el.remove());
        const cached = await cacheManager.getValue(screenName.toLowerCase());
        const account = cached?.account?.data?.user_result_by_screen_name?.result;
        if (!account || !extensionEnabled || tooltipRenderEpoch !== renderEpoch) return;

        tooltip = document.createElement('div');
        tooltip.className = 'twitter-location-tooltip';
        // Use cached theme styles for performance
        const theme = cachedThemeStyles || computeTooltipThemeStyles();
        tooltip.style.position = 'absolute';
        tooltip.style.zIndex = 9999;
        tooltip.style.background = theme.backgroundColor;
        tooltip.style.color = theme.textColor;
        tooltip.style.padding = '20px 24px';
        tooltip.style.borderRadius = '18px';
        tooltip.style.boxShadow = theme.boxShadow;
        tooltip.style.fontSize = '1em';
        tooltip.style.maxWidth = '340px';
        tooltip.style.pointerEvents = 'auto';
        tooltip.style.userSelect = 'text';
        tooltip.style.border = `1px solid ${theme.borderColor}`;

        const title = document.createElement("div");
        title.style.cssText = "font-weight:700;font-size:1.15em;margin-bottom:18px;";
        title.textContent = "About this account";
        tooltip.appendChild(title);

        const profile = document.createElement("div");
        profile.style.cssText = "display:flex;align-items:center;margin-bottom:16px;";
        if (typeof account.avatar?.image_url === "string") {
          try {
            const avatarUrl = new URL(account.avatar.image_url);
            if (avatarUrl.protocol === "https:") {
              const avatar = document.createElement("img");
              avatar.src = avatarUrl.href.replace("_normal", "_bigger");
              avatar.alt = "";
              avatar.style.cssText = "width:48px;height:48px;border-radius:50%;margin-right:14px;";
              profile.appendChild(avatar);
            }
          } catch (error) {
            // Skip invalid avatar URLs.
          }
        }
        const identity = document.createElement("div");
        const name = document.createElement("div");
        name.style.cssText = "font-weight:600;font-size:1.1em;";
        name.textContent = account.core?.name || "";
        const handle = document.createElement("div");
        handle.style.color = theme.accentColor;
        handle.textContent = `@${account.core?.screen_name || ""}`;
        identity.appendChild(name);
        identity.appendChild(handle);
        profile.appendChild(identity);
        tooltip.appendChild(profile);

        const appendDetail = (icon, text) => {
          const row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;margin-bottom:10px;gap:10px;";
          const symbol = document.createElement("span");
          symbol.style.fontSize = "1.2em";
          symbol.textContent = icon;
          const value = document.createElement("span");
          value.textContent = text;
          row.appendChild(symbol);
          row.appendChild(value);
          tooltip.appendChild(row);
          return row;
        };

        appendDetail("📅", `Joined ${account.core?.created_at ? new Date(account.core.created_at).toLocaleString('default', { month: 'long', year: 'numeric' }) : "Unknown"}`);

        if (account.about_profile?.account_based_in) {
          const row = appendDetail("📍", `Account based in ${account.about_profile.account_based_in}`);
          if (account.about_profile?.location_accurate) {
            const shield = document.createElement("span");
            shield.style.cssText = "margin-left:6px;font-size:1.1em;";
            shield.title = "Location accurate";
            shield.textContent = "🛡️";
            row.appendChild(shield);
          }
        }

        if (account.verification_info?.reason?.verified_since_msec) {
          const since = new Date(Number(account.verification_info.reason.verified_since_msec));
          appendDetail("✅", `Verified since ${since.toLocaleString('default', { month: 'long', year: 'numeric' })}`);
        } else if (account.verification?.verified || account.is_blue_verified) {
          appendDetail("✅", "Verified");
        }

        if (account.about_profile?.source) {
          appendDetail("🌐", `Connected via ${account.about_profile.source}`);
        }

        if (account.about_profile?.username_changes) {
          let text = `Username changes: ${account.about_profile.username_changes.count}`;
          if (account.about_profile.username_changes.last_changed_at_msec) {
            const d = new Date(Number(account.about_profile.username_changes.last_changed_at_msec));
            text += ` (last: ${d.toLocaleDateString()})`;
          }
          appendDetail("🔄", text);
        }

        document.body.appendChild(tooltip);

        // Position tooltip near location span
        const rect = locationSpan.getBoundingClientRect();
        tooltip.style.left = `${rect.left + window.scrollX}px`;
        tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;

        // Hide logic: only hide when mouse leaves both locationSpan and tooltip
        tooltip.addEventListener('mouseenter', () => {
          if (hideTimeout) clearTimeout(hideTimeout);
        });
        tooltip.addEventListener('mouseleave', () => {
          hideTimeout = setTimeout(hideTooltip, 80);
        });
      })();
    };
    const hideTooltip = () => {
      if (tooltip) {
        tooltip.remove();
        tooltip = null;
      }
    };
    locationSpan.addEventListener('mouseenter', () => {
      if (hideTimeout) clearTimeout(hideTimeout);
      showTooltip();
    });
    locationSpan.addEventListener('mouseleave', () => {
      hideTimeout = setTimeout(hideTooltip, 80);
    });

    // Use userNameContainer found above, or find it if not found, or fallback to usernameElement
    let containerForLocation =
      userNameContainer ||
      usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
    if (!containerForLocation) {
      // Fallback: use usernameElement itself
      containerForLocation = usernameElement;
    }

    // Insert location using unified helper
    let inserted = insertElementNearHandle(containerForLocation, screenName, locationSpan);

    if (inserted) {
      // Mark as processed
      usernameElement.dataset.locationAdded = "true";
      // Clear waiting flag if present
      delete usernameElement.dataset.locationWaiting;

      // Also mark any other containers waiting for this username
      document.querySelectorAll(`[data-location-waiting="true"]`).forEach((container) => {
        const waitingUsername = extractUsername(container);
        if (waitingUsername?.toLowerCase() === screenName.toLowerCase()) {
          // Clear waiting flag and add location to this container too
          delete container.dataset.locationWaiting;
          addLocationToUsername(container, screenName).catch(() => {});
        }
      });
    } else {
      console.error(
        `✗ Failed to insert location for ${screenName} - tried all strategies`
      );
      // Remove any transient marks so this can be retried later
      delete usernameElement.dataset.locationAdded;
      delete usernameElement.dataset.locationWaiting;
    }
  } catch (error) {
    console.error(`Error processing location for ${screenName}:`, error);
    // Remove spinner on error
    if (spinnerInserted && spinnerSpan.parentNode) {
      spinnerSpan.remove();
    }
    // Remove transient marks so it can be retried later
    delete usernameElement.dataset.locationAdded;
    delete usernameElement.dataset.locationWaiting;
  }
}

// Function to remove all locations (when extension is disabled)
function removeAllLocations() {
  document.querySelectorAll(".twitter-location-tooltip").forEach((tooltip) => tooltip.remove());
  document.querySelectorAll("[data-twitter-location]").forEach((loc) => loc.remove());
  document.querySelectorAll("[data-twitter-location-spinner]").forEach((spinner) => spinner.remove());
  document.querySelectorAll("[data-location-added]").forEach((container) => {
    delete container.dataset.locationAdded;
  });
  document.querySelectorAll("[data-location-waiting]").forEach((container) => {
    delete container.dataset.locationWaiting;
  });
}

// Function to process all username elements on the page
async function processUsernames(containers) {
  // Check if extension is enabled
  if (!extensionEnabled) {
    return;
  }

  // Find all tweet/article containers and user cells
  containers = containers || document.querySelectorAll(USER_CONTAINER_SELECTOR);

  for (const container of containers) {
    if (!container.isConnected) continue;
    if (clearedContainers.has(container)) continue;
    const screenName = extractUsername(container);
    if (screenName) {
      // Process if not already added
      if (container.dataset.locationAdded !== "true") {
        // Process in parallel but limit concurrency
        addLocationToUsername(container, screenName).catch((err) => {
          console.error(`Error processing ${screenName}:`, err);
          // Ensure transient marks are cleared so retry is possible
          delete container.dataset.locationAdded;
          delete container.dataset.locationWaiting;
        });
      }
    } else {
      // do nothing
    }
  }
}

// Observe dynamically added nodes (for infinite scroll)
function observeDynamicContent() {
  if (observer) {
    observer.disconnect();
  }
  if (contentScanTimer !== null) {
    clearTimeout(contentScanTimer);
    contentScanTimer = null;
  }

  const pendingRoots = new Set();
  const pendingContainers = new Set();
  const collectAncestors = (element) => {
    let container = element.closest(USER_CONTAINER_SELECTOR);
    while (container) {
      pendingContainers.add(container);
      container = container.parentElement?.closest(USER_CONTAINER_SELECTOR);
    }
  };

  observer = new MutationObserver((mutations) => {
    if (!extensionEnabled) return;
    for (const mutation of mutations) {
      if (mutation.target.closest(LOCATION_UI_SELECTOR)) continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && node.closest(LOCATION_UI_SELECTOR)) continue;
        // A handle can be added to an existing container as text or nested markup.
        collectAncestors(mutation.target);
        if (node.nodeType === 1) pendingRoots.add(node);
      }
    }
    if (contentScanTimer !== null || (!pendingRoots.size && !pendingContainers.size)) return;
    contentScanTimer = setTimeout(() => {
      contentScanTimer = null;
      for (const root of pendingRoots) {
        if (!root.isConnected) continue;
        collectAncestors(root);
        root.querySelectorAll(USER_CONTAINER_SELECTOR).forEach((container) => pendingContainers.add(container));
      }
      pendingRoots.clear();
      const containers = Array.from(pendingContainers);
      pendingContainers.clear();
      processUsernames(containers);
    }, 0);
  });

  // Observe the body or a specific container
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// Initial setup
(async () => {
  // Load enabled state
  await loadEnabledState();

  // Inject the page script for fetch access
  try {
    await injectPageScript();
    pageScriptReady = true;
  } catch (error) {
    console.error("Unable to initialize account requests:", error);
    return;
  }

  // Initialize theme cache for tooltip performance
  initializeThemeCache();

  // Restore any queued usernames from a previous page load
  await restorePersistedQueue();

  // Process usernames on initial load
  processUsernames();

  // Observe dynamic content
  observeDynamicContent();
})();
