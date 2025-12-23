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

// Store latest rate limit info
let latestRateLimitInfo = {
  limit: null,
  remaining: null,
  resetTime: null,
  waitTime: null,
};

// Observer for dynamically loaded content
let observer = null;

// Cached theme styles for tooltip performance
let cachedThemeStyles = null;
let themeObserver = null;
let themeDebounceTimer = null;

// Extension enabled state
let extensionEnabled = true;
const TOGGLE_KEY = "extension_enabled";
const DEFAULT_ENABLED = true;

// Load enabled state
async function loadEnabledState() {
  try {
    const result = await browser.storage.local.get([TOGGLE_KEY]);
    extensionEnabled =
      result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
  } catch (error) {
    console.error("Error loading enabled state:", error);
    extensionEnabled = DEFAULT_ENABLED;
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
    sendResponse(latestRateLimitInfo);
    return true;
  } else if (request.type === "extensionToggle") {
    extensionEnabled = request.enabled;
    if (extensionEnabled) {
      setTimeout(() => {
        processUsernames();
      }, 500);
    } else {
      removeAllLocations();
    }
    return;
  } else if (request.type === "getCacheCount") {
    (async () => {
      try {
        if (typeof cacheManager === "undefined") {
          sendResponse({ count: 0 });
          return;
        }
        const count = await cacheManager.getCacheCount();
        sendResponse({ count });
      } catch (e) {
        sendResponse({ count: 0 });
      }
    })();
    return true;
  }
});

// Inject script into page context to access fetch with proper cookies
function injectPageScript() {
  const script = document.createElement("script");
  script.src = browser.runtime.getURL("src/pageScript.js");
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

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
    }
  });
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
async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.size === 0) {
    return;
  }

  // Check if we're rate limited
  if (rateLimitResetTime > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now < rateLimitResetTime) {
      const waitTime = (rateLimitResetTime - now) * 1000;

      setTimeout(processRequestQueue, Math.min(waitTime, 60000)); // Check every minute max
      return;
    } else {
      // Rate limit expired, reset
      rateLimitResetTime = 0;
    }
  }

  isProcessingQueue = true;

  while (requestQueue.size > 0) {
    // Re-check rate limit before starting each request
    if (rateLimitResetTime > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec < rateLimitResetTime) {
        const waitTime = (rateLimitResetTime - nowSec) * 1000;
        setTimeout(processRequestQueue, Math.min(waitTime, 60000));
        break;
      } else {
        // Rate limit expired, reset and continue
        rateLimitResetTime = 0;
      }
    }

    // Get the next screenName to process
    const screenName = requestQueue.keys().next().value;
    const callbacks = requestQueue.get(screenName);

    // Remove from queue
    requestQueue.delete(screenName);

    // Make the request
    makeAboutAccountQueryRequest(screenName)
      .then((location) => {
        callbacks.forEach(({ resolve }) => resolve(location));
      })
      .catch((error) => {
        callbacks.forEach(({ reject }) => reject(error));
      })
      .finally(() => {
        // Continue processing queue after a short pause
        setTimeout(processRequestQueue, 200);
      });
  }

  isProcessingQueue = false;
}

// Make actual API request
function makeAboutAccountQueryRequest(screenName) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random();

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
        window.removeEventListener("message", handler);
        const account = event.data.account;
        const isRateLimited = event.data.isRateLimited || false;

        // If the page signalled rate-limiting, trigger immediate backoff so we stop
        // sending further requests for a while. Do not cache rate-limited failures.
        if (isRateLimited) {
          // Backoff is handled in the message listener for __rateLimitInfo
        } else {
          // Only cache if not rate limited (don't cache failures due to rate limiting)
          await cacheManager.saveCacheEntry(screenName, account || null);
        }

        resolve(account);
      }
    };

    window.addEventListener("message", handler);

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
  // Check if there's already a request in progress for this username
  let promise = inFlightRequests.get(screenName);
  if (promise) {
    return promise;
  }

  // Create a new promise for this request
  promise = (async () => {
    // Check cache first
    const data = await cacheManager.getValue(screenName);

    if (data !== undefined && data.account) {
      // Return the full cached account JSON response
      return data.account;
    }

    // Not cached, queue the API request
    return new Promise((resolve, reject) => {
      if (!requestQueue.has(screenName)) {
        requestQueue.set(screenName, []);
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
  promise.finally(() => {
    inFlightRequests.delete(screenName);
  });

  return promise;
}

// Function to extract username from various Twitter UI elements
function extractUsername(element) {
  // Try data-testid="UserName" or "User-Name" first (most reliable)
  let usernameElement = element.querySelector(
    '[data-testid="UserName"], [data-testid="User-Name"]'
  );

  // check if element contains [data-testid="UserCell"]
  if (element.getAttribute("data-testid") === "UserCell") {
    usernameElement = element;
  }

  if (usernameElement) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');

    for (const link of links) {
      const href = link.getAttribute("href");
      const match = href.match(/^\/([^/?]+)/);
      if (match && match[1]) {
        const username = match[1];

        // Filter out common routes
        if (
          !EXCLUDED_ROUTES.includes(username) &&
          !username.startsWith("hashtag") &&
          !username.startsWith("search") &&
          username.length > 0 &&
          username.length <= 15
        ) {
          return username;
        }
      }
    }
  }

  // Try finding username links in the entire element (broader search)
  const allLinks = element.querySelectorAll('a[href^="/"]');
  const seenUsernames = new Set();

  for (const link of allLinks) {
    const href = link.getAttribute("href");
    if (!href) continue;

    const match = href.match(/^\/([^/?]+)/);
    if (!match || !match[1]) continue;

    const potentialUsername = match[1];

    // Skip if we've already checked this username
    if (seenUsernames.has(potentialUsername)) continue;
    seenUsernames.add(potentialUsername);

    // Filter out routes and invalid usernames
    if (
      EXCLUDED_ROUTES.some(
        (route) =>
          potentialUsername === route || potentialUsername.startsWith(route)
      )
    ) {
      continue;
    }

    // Skip status/tweet links
    if (
      potentialUsername.includes("status") ||
      potentialUsername.match(/^\d+$/)
    ) {
      continue;
    }

    // Check link text/content for username indicators
    const text = link.textContent?.trim() || "";
    const linkText = text.toLowerCase();
    const usernameLower = potentialUsername.toLowerCase();

    // If link text starts with @, it's definitely a username
    if (text.startsWith("@")) {
      return potentialUsername;
    }

    // If link text matches the username (without @), it's likely a username
    if (linkText === usernameLower || linkText === `@${usernameLower}`) {
      return potentialUsername;
    }

    // Check if link is in a UserName container or has username-like structure
    const parent = link.closest(
      '[data-testid="UserName"], [data-testid="User-Name"]'
    );
    if (parent) {
      // If it's in a UserName container and looks like a username, return it
      if (
        potentialUsername.length > 0 &&
        potentialUsername.length <= 15 &&
        !potentialUsername.includes("/")
      ) {
        return potentialUsername;
      }
    }

    // Also check if link text is @username format
    if (text && text.trim().startsWith("@")) {
      const atUsername = text.trim().substring(1);
      if (atUsername === potentialUsername) {
        return potentialUsername;
      }
    }
  }

  // Last resort: look for @username pattern in text content and verify with link
  const textContent = element.textContent || "";
  const atMentionMatches = textContent.matchAll(/@([a-zA-Z0-9_]+)/g);
  for (const match of atMentionMatches) {
    const username = match[1];
    // Verify it's actually a link in a User-Name container
    const link = element.querySelector(
      `a[href="/${username}"], a[href^="/${username}?"]`
    );
    if (link) {
      // Make sure it's in a username context, not just mentioned in tweet text
      const isInUserNameContainer = link.closest(
        '[data-testid="UserName"], [data-testid="User-Name"]'
      );
      if (isInUserNameContainer) {
        return username;
      }
    }
  }

  return null;
}

// Helper function to find handle section
function findHandleSection(container, screenName) {
  return Array.from(container.querySelectorAll("div")).find((div) => {
    const link = div.querySelector(`a[href="/${screenName}"]`);
    if (link) {
      const text = link.textContent?.trim();
      return text === `@${screenName}`;
    }
    return false;
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
  // Check if location already added
  if (usernameElement.dataset.locationAdded === "true") {
    return;
  }

  // If there's already an in-flight request for this username, mark this container
  // as waiting and return — the successful request will update waiting containers.
  if (inFlightRequests.has(screenName)) {
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

    if (!account) {
      // Not cached or not found, do not show anything
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
      (async () => {
        document.querySelectorAll('.twitter-location-tooltip').forEach((el) => el.remove());
        const cached = await cacheManager.getValue(screenName);
        const account = cached?.account?.data?.user_result_by_screen_name?.result;
        if (!account) return;

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

        let html = "<div style='font-weight:700;font-size:1.15em;margin-bottom:18px;'>About this account</div>";
        html += `<div style='display:flex;align-items:center;margin-bottom:16px;'>`;
        if (account.avatar?.image_url) {
          html += `<img src='${account.avatar.image_url.replace("_normal", "_bigger")}' style='width:48px;height:48px;border-radius:50%;margin-right:14px;'>`;
        }
        html += `<div><div style='font-weight:600;font-size:1.1em;'>${account.core?.name || ""}</div>`;
        html += `<div style='color:${theme.accentColor};'>@${account.core?.screen_name || ""}</div></div></div>`;

        html += `<div style='display:flex;align-items:center;margin-bottom:10px;gap:10px;'><span style='font-size:1.2em;'>📅</span><span>Joined ${account.core?.created_at ? new Date(account.core.created_at).toLocaleString('default', { month: 'long', year: 'numeric' }) : "Unknown"}</span></div>`;

        if (account.about_profile?.account_based_in) {
          html += `<div style='display:flex;align-items:center;margin-bottom:10px;gap:10px;'><span style='font-size:1.2em;'>📍</span><span>Account based in ${account.about_profile.account_based_in}</span>`;
          if (account.about_profile?.location_accurate) {
            html += `<span style='margin-left:6px;font-size:1.1em;' title='Location accurate'>🛡️</span>`;
          }
          html += `</div>`;
        }

        if (account.verification_info?.reason?.verified_since_msec) {
          const since = new Date(Number(account.verification_info.reason.verified_since_msec));
          html += `<div style='display:flex;align-items:center;margin-bottom:10px;gap:10px;'><span style='font-size:1.2em;'>✅</span><span>Verified since ${since.toLocaleString('default', { month: 'long', year: 'numeric' })}</span></div>`;
        } else if (account.verification?.verified || account.is_blue_verified) {
          html += `<div style='display:flex;align-items:center;margin-bottom:10px;gap:10px;'><span style='font-size:1.2em;'>✅</span><span>Verified</span></div>`;
        }

        if (account.about_profile?.source) {
          html += `<div style='display:flex;align-items:center;margin-bottom:10px;gap:10px;'><span style='font-size:1.2em;'>🌐</span><span>Connected via ${account.about_profile.source}</span></div>`;
        }

        if (account.about_profile?.username_changes) {
          html += `<div style='display:flex;align-items:center;margin-bottom:10px;gap:10px;'><span style='font-size:1.2em;'>🔄</span><span>Username changes: ${account.about_profile.username_changes.count}`;
          if (account.about_profile.username_changes.last_changed_at_msec) {
            const d = new Date(Number(account.about_profile.username_changes.last_changed_at_msec));
            html += ` (last: ${d.toLocaleDateString()})`;
          }
          html += `</span></div>`;
        }


        // Safer: use DOMParser to parse the HTML and append nodes
        // This avoids direct assignment to innerHTML with dynamic content
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
        Array.from(doc.body.firstChild.childNodes).forEach(node => tooltip.appendChild(node));
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
        if (waitingUsername === screenName) {
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
async function processUsernames() {
  // Check if extension is enabled
  if (!extensionEnabled) {
    return;
  }

  // Find all tweet/article containers and user cells
  const containers = document.querySelectorAll(
    'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="User-Names"], [data-testid="User-Name"]'
  );

  for (const container of containers) {
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

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            // Element nodes only
            processUsernames();
          }
        });
      }
    }
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
  injectPageScript();

  // Initialize theme cache for tooltip performance
  initializeThemeCache();

  // Process usernames on initial load
  processUsernames();

  // Observe dynamic content
  observeDynamicContent();
})();
