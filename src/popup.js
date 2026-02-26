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
const clearQueueButtonEl = document.getElementById("clearQueueButton");

const tabProfilesEl = document.getElementById("tabProfiles");
const tabStatsEl = document.getElementById("tabStats");
const tabPanelProfilesEl = document.getElementById("tabPanelProfiles");
const tabPanelStatsEl = document.getElementById("tabPanelStats");
const profilesListEl = document.getElementById("profilesList");
const countryStatsEl = document.getElementById("countryStats");
const profilesSearchEl = document.getElementById("profilesSearch");

let allCacheEntries = [];

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

    initializeTabs();
    await renderCacheViews();
    initializeProfilesSearch();
    initializeClearQueueButton();
  } catch (e) {
    console.error("Error loading toggle state in popup:", e);
    updateToggle(DEFAULT_ENABLED);
  }
})();

function initializeClearQueueButton() {
  if (!clearQueueButtonEl) return;

  clearQueueButtonEl.addEventListener("click", async () => {
    clearQueueButtonEl.disabled = true;
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tabs[0]?.id) {
        return;
      }

      await browser.tabs.sendMessage(tabs[0].id, {
        type: "clearPersistedQueue",
      });

      await updateRateLimitInfo();
    } catch (e) {
      console.error("Error clearing queue:", e);
    } finally {
      clearQueueButtonEl.disabled = false;
    }
  });
}

function initializeProfilesSearch() {
  if (!profilesSearchEl) return;

  const applyFilter = () => {
    const query = (profilesSearchEl.value || "").trim().toLowerCase();
    if (!query) {
      renderProfiles(allCacheEntries);
      return;
    }

    const filtered = (allCacheEntries || []).filter((e) => {
      const username = String(e.username || "").toLowerCase();
      const location = String(e.location || "").toLowerCase();
      return username.includes(query) || location.includes(query);
    });

    renderProfiles(filtered, { isFiltered: true });
  };

  profilesSearchEl.addEventListener("input", applyFilter);

  profilesSearchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      profilesSearchEl.value = "";
      applyFilter();
    }
  });
}

function initializeTabs() {
  if (!tabProfilesEl || !tabStatsEl) return;

  const setActive = (tab) => {
    const isProfiles = tab === "profiles";

    tabProfilesEl.classList.toggle("active", isProfiles);
    tabStatsEl.classList.toggle("active", !isProfiles);

    tabProfilesEl.setAttribute("aria-selected", String(isProfiles));
    tabStatsEl.setAttribute("aria-selected", String(!isProfiles));

    if (tabPanelProfilesEl) tabPanelProfilesEl.hidden = !isProfiles;
    if (tabPanelStatsEl) tabPanelStatsEl.hidden = isProfiles;
  };

  tabProfilesEl.addEventListener("click", () => setActive("profiles"));
  tabStatsEl.addEventListener("click", () => setActive("stats"));

  setActive("profiles");
}

async function loadAllCacheEntries() {
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tabs[0]?.id) {
      return [];
    }

    const response = await browser.tabs.sendMessage(tabs[0].id, {
      type: "getAllCacheEntries",
    });

    if (response && Array.isArray(response.entries)) {
      return response.entries;
    }

    return [];
  } catch (e) {
    console.error("Error loading cache entries:", e);
    return [];
  }
}

async function renderCacheViews() {
  if (!profilesListEl || !countryStatsEl) return;

  profilesListEl.textContent = "Loading...";
  countryStatsEl.textContent = "Loading...";

  const entries = await loadAllCacheEntries();

  allCacheEntries = entries;

  renderProfiles(entries);
  renderCountryStats(entries);
}

function renderProfiles(entries, { isFiltered = false } = {}) {
  if (!profilesListEl) return;

  if (!entries || entries.length === 0) {
    profilesListEl.textContent = isFiltered
      ? "No matching profiles."
      : "No cached profiles.";
    return;
  }

  const sorted = [...entries].sort(
    (a, b) => (b.cachedAt || 0) - (a.cachedAt || 0)
  );
  const fragment = document.createDocumentFragment();

  for (const entry of sorted) {
    const username = entry.username;
    const locationText = entry.location || "Unknown";
    const avatarUrl = entry.avatarUrl;

    const row = document.createElement("div");
    row.className = "row profile-row";

    if (avatarUrl) {
      const avatar = document.createElement("img");
      avatar.className = "avatar";
      avatar.src = avatarUrl;
      avatar.alt = "";
      avatar.loading = "lazy";
      row.appendChild(avatar);
    }

    const left = document.createElement("div");
    left.className = "left";

    const handle = document.createElement("div");
    handle.className = "handle";
    handle.textContent = username ? `@${username}` : "(unknown)";

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = locationText;

    left.appendChild(handle);
    left.appendChild(sub);
    row.appendChild(left);

    fragment.appendChild(row);
  }

  profilesListEl.textContent = "";
  profilesListEl.appendChild(fragment);
}

function renderCountryStats(entries) {
  if (!countryStatsEl) return;

  if (!entries || entries.length === 0) {
    countryStatsEl.textContent = "No cached profiles.";
    return;
  }

  const counts = new Map();
  for (const entry of entries) {
    const locationText = entry.location || "Unknown";
    counts.set(locationText, (counts.get(locationText) || 0) + 1);
  }

  const rows = Array.from(counts.entries())
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => b.count - a.count);

  const maxCount = rows[0]?.count || 1;
  const fragment = document.createDocumentFragment();

  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "row";

    const left = document.createElement("div");
    left.className = "left";

    const label = document.createElement("div");
    label.className = "handle";
    label.textContent = item.location;

    const bar = document.createElement("div");
    bar.className = "bar";
    const barInner = document.createElement("div");
    const pct = Math.round((item.count / maxCount) * 100);
    barInner.style.width = `${pct}%`;
    bar.appendChild(barInner);

    left.appendChild(label);
    left.appendChild(bar);

    const count = document.createElement("div");
    count.className = "count";
    count.textContent = String(item.count);

    row.appendChild(left);
    row.appendChild(count);

    fragment.appendChild(row);
  }

  countryStatsEl.textContent = "";
  countryStatsEl.appendChild(fragment);
}

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

        if (typeof response.queueDistinct === "number") {
          text += ` | Queue: ${response.queueDistinct}`;
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
