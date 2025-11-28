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
    console.log("Extension enabled:", extensionEnabled);
  } catch (error) {
    console.error("Error loading enabled state:", error);
    extensionEnabled = DEFAULT_ENABLED;
  }
}

// Listen for toggle changes from popup
browser.runtime.onMessage.addListener(async (request) => {
  if (request.type === "getRateLimitInfo") {
    // Return latest rate limit info
    return latestRateLimitInfo;
  } else if (request.type === "extensionToggle") {
    extensionEnabled = request.enabled;
    console.log("Extension toggled:", extensionEnabled);

    if (extensionEnabled) {
      // Re-initialize if enabled
      setTimeout(() => {
        processUsernames();
      }, 500);
    } else {
      // Remove all locations if disabled
      removeAllLocations();
    }
  } else if (request.type === "getCacheCount") {
    try {
      const count = await cacheManager.getCacheCount();
      return { count };
    } catch (e) {
      console.error("Error getting cache count:", e);
      return { count: 0 };
    }
  }
});

// Inject script into page context to access fetch with proper cookies
function injectPageScript() {
  const script = document.createElement("script");
  script.src = browser.runtime.getURL("pageScript.js");
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
      // Store extra info if available
      if (typeof event.data.limit !== "undefined")
        latestRateLimitInfo.limit = event.data.limit;
      if (typeof event.data.remaining !== "undefined")
        latestRateLimitInfo.remaining = event.data.remaining;
      if (typeof event.data.resetTime !== "undefined")
        latestRateLimitInfo.resetTime = event.data.resetTime;
      if (typeof event.data.waitTime !== "undefined")
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
        console.log(
          `Rate limited while processing queue. Pausing further requests for ${Math.ceil(
            waitTime / 1000 / 60
          )} minutes...`
        );
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
    console.log(`Reusing in-flight request for ${screenName}`);
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
    console.log(`Queuing API request for ${screenName}`);
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
  // console.log("Extracting username from element:", element);

  // Try data-testid="UserName" or "User-Name" first (most reliable)
  let usernameElement = element.querySelector(
    '[data-testid="UserName"], [data-testid="User-Name"]'
  );

  // check if element contains [data-testid="UserCell"]
  if (element.getAttribute("data-testid") === "UserCell") {
    usernameElement = element;
  }

  // console.log("Username element for extraction:", usernameElement);

  if (usernameElement) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    // console.log("Links found for username extraction:", links);
    for (const link of links) {
      const href = link.getAttribute("href");
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1]) {
        const username = match[1];
        // console.log("Extracted username:", username);

        // Filter out common routes
        if (
          !EXCLUDED_ROUTES.includes(username) &&
          !username.startsWith("hashtag") &&
          !username.startsWith("search") &&
          username.length > 0 &&
          username.length < 20
        ) {
          // Usernames are typically short
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

    const match = href.match(/^\/([^\/\?]+)/);
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
        potentialUsername.length < 20 &&
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
    if (!spinnerInserted) {
      console.log("Failed to insert spinner");
    }
  }

  try {
    const account = await getAboutAccount(screenName);

    // console.log(`Fetched account info for ${screenName}:`, account);

    // Remove spinner
    if (spinnerInserted && spinnerSpan.parentNode) {
      spinnerSpan.remove();
    }

    const location = account?.data?.user_result_by_screen_name?.result?.about_profile?.account_based_in || null;

    if (!location) {
      console.log(`Fetched account info for ${screenName}:`, account);
      console.log(`No location found for ${screenName}, leaving unmarked`);
      usernameElement.dataset.locationAdded = "true";
      // Leave container without `data-location-added` so it can be retried later.
      return;
    }

    // Use location text directly (show location as-is)
    const locationText =
      typeof location === "string" ? location.trim() : String(location);
    if (!locationText) {
      console.log(`No usable location text for ${screenName}:`, location);
      // Remove transient marks so it can be retried later
      delete usernameElement.dataset.locationAdded;
      delete usernameElement.dataset.locationWaiting;
      return;
    }

    // Check if a location element already exists (check in the entire container)
    const existingLocation = usernameElement.querySelector(
      "[data-twitter-location]"
    );
    if (existingLocation) {
      usernameElement.dataset.locationAdded = "true";
      return;
    }

    // Add location text formatted as '(Location)' - place it next to verification badge, before @ handle
    const locationSpan = document.createElement("span");
    locationSpan.textContent = ` (${locationText})`;
    locationSpan.setAttribute("data-twitter-location", "true");
    locationSpan.style.marginLeft = "4px";
    locationSpan.style.marginRight = "4px";
    locationSpan.style.display = "inline";
    locationSpan.style.color = "#1d9bf0"; // Twitter blue accent
    locationSpan.style.fontSize = "0.95em";
    locationSpan.style.fontWeight = "500";
    locationSpan.style.verticalAlign = "middle";

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
      const waitingContainers = document.querySelectorAll(
        `[data-location-waiting="true"]`
      );
      waitingContainers.forEach((container) => {
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
  const locations = document.querySelectorAll("[data-twitter-location]");
  locations.forEach((loc) => loc.remove());

  // Also remove any loading spinners
  const spinners = document.querySelectorAll("[data-twitter-location-spinner]");
  spinners.forEach((spinner) => spinner.remove());

  // Reset location added markers
  const addedContainers = document.querySelectorAll("[data-location-added]");
  addedContainers.forEach((container) => {
    delete container.dataset.locationAdded;
  });
  const waitingContainers = document.querySelectorAll(
    "[data-location-waiting]"
  );
  waitingContainers.forEach((container) => {
    delete container.dataset.locationWaiting;
  });

  console.log("Removed all locations");
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

  let foundCount = 0;
  let processedCount = 0;
  let skippedCount = 0;

  for (const container of containers) {
    const screenName = extractUsername(container);
    if (screenName) {
      foundCount++;
      // Process if not already added
      if (container.dataset.locationAdded !== "true") {
        processedCount++;
        // Process in parallel but limit concurrency
        addLocationToUsername(container, screenName).catch((err) => {
          console.error(`Error processing ${screenName}:`, err);
          // Ensure transient marks are cleared so retry is possible
          delete container.dataset.locationAdded;
          delete container.dataset.locationWaiting;
        });
      } else {
        skippedCount++;
      }
    } else {
      // Debug: log containers that don't have usernames
      const hasUserName = container.querySelector(
        '[data-testid="UserName"], [data-testid="User-Name"]'
      );
      if (hasUserName) {
        console.log("Found UserName container but no username extracted");
      }
    }
  }
}

// Initialize observer for dynamically loaded content
function initObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    // Don't process if extension is disabled
    if (!extensionEnabled) {
      return;
    }

    let shouldProcess = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldProcess = true;
        break;
      }
    }

    if (shouldProcess) {
      // Debounce processing
      setTimeout(processUsernames, 500);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// Main initialization
async function init() {
  console.log("Twitter Location extension initialized");

  // Load enabled state first
  await loadEnabledState();

  // Load persistent cache
  await cacheManager.loadCache();

  // Only proceed if extension is enabled
  if (!extensionEnabled) {
    console.log("Extension is disabled");
    return;
  }

  // Inject page script
  injectPageScript();

  // Wait a bit for page to fully load
  setTimeout(() => {
    processUsernames();
  }, 2000);

  // Set up observer for new content
  initObserver();

  // Re-process on navigation (Twitter uses SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log("Page navigation detected, reprocessing usernames");
      setTimeout(processUsernames, 2000);
    }
  }).observe(document, { subtree: true, childList: true });
}

// Wait for page to load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
