// Popup script for extension toggle
// Small compatibility: if `browser` is not defined (Chrome), fall back to `chrome`
if (typeof browser === "undefined") {
  var browser = chrome;
}

const TOGGLE_KEY = "extension_enabled";
const DEFAULT_ENABLED = true;

const toggleSwitchEl = document.getElementById("toggleSwitch");
const statusEl = document.getElementById("status");
const cacheInfoEl = document.getElementById("cacheInfo");
const rateLimitInfoEl = document.getElementById("rateLimitInfo");

// Load current state
(async function initPopup() {
  try {
    const result = await browser.storage.local.get([TOGGLE_KEY]);
    const isEnabled =
      result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    updateToggle(isEnabled);
    await updateCacheCount();
    await updateRateLimitInfo();
    // Show extension version only
    const manifest = browser.runtime.getManifest();
    const version = manifest.version || "?";
    const extVersion = document.getElementById("extVersion");
    if (extVersion) {
      extVersion.textContent = `Version: ${version}`;
    }
  } catch (e) {
    console.error("Error loading toggle state in popup:", e);
    updateToggle(DEFAULT_ENABLED);
  }
})();

async function updateRateLimitInfo() {
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tabs[0]) {
      const response = await browser.tabs.sendMessage(tabs[0].id, {
        type: "getRateLimitInfo",
      });
      if (response && typeof response === "object") {
        let text = "API Rate Limit: ";
        if (
          response.limit !== null &&
          response.remaining !== null &&
          response.resetTime !== null
        ) {
          const resetDate = new Date(response.resetTime * 1000);
          text += `${response.remaining} / ${
            response.limit
          } remaining. Reset: ${resetDate.toLocaleTimeString()}`;
        } else {
          text += "Unknown";
        }
        rateLimitInfoEl.textContent = text;
      } else {
        rateLimitInfoEl.textContent = "API Rate Limit: Unable to load";
      }
    } else {
      rateLimitInfoEl.textContent = "API Rate Limit: No active tab";
    }
  } catch (e) {
    console.error("Error getting rate limit info:", e);
    rateLimitInfoEl.textContent = "API Rate Limit: Error";
  }
}
// Toggle click handler
toggleSwitchEl.addEventListener("click", async () => {
  try {
    const result = await browser.storage.local.get([TOGGLE_KEY]);
    const currentState =
      result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    const newState = !currentState;

    await browser.storage.local.set({ [TOGGLE_KEY]: newState });
    updateToggle(newState);

    // Notify content script to update
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tabs[0]) {
        await browser.tabs.sendMessage(tabs[0].id, {
          type: "extensionToggle",
          enabled: newState,
        });
      }
    } catch (e) {
      // Tab might not have content script loaded yet or no permission; ignore
    }
  } catch (error) {
    console.error("Error toggling extension state:", error);
  }
});

function updateToggle(isEnabled) {
  if (isEnabled) {
    toggleSwitchEl.classList.add("enabled");
    statusEl.textContent = "Extension is enabled";
    statusEl.style.color = "#1d9bf0";
  } else {
    toggleSwitchEl.classList.remove("enabled");
    statusEl.textContent = "Extension is disabled";
    statusEl.style.color = "#536471";
  }
}

async function updateCacheCount() {
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tabs[0]) {
      const response = await browser.tabs.sendMessage(tabs[0].id, {
        type: "getCacheCount",
      });
      if (response && typeof response.count === "number") {
        cacheInfoEl.textContent = `Cached locations: ${response.count}`;
      } else {
        cacheInfoEl.textContent = "Cached locations: Unable to load";
      }
    } else {
      cacheInfoEl.textContent = "Cached locations: No active tab";
    }
  } catch (e) {
    console.error("Error getting cache count:", e);
    cacheInfoEl.textContent = "Cached locations: Error";
  }
}
