// Popup script for extension toggle
// Small compatibility: if `browser` is not defined (Chrome), fall back to `chrome`
if (typeof browser === "undefined") {
  var browser = chrome;
}

const TOGGLE_KEY = "extension_enabled";
const DEFAULT_ENABLED = true;

const toggleSwitchEl = document.getElementById("toggleSwitch");
const cacheInfoEl = document.getElementById("cacheInfo");
const rateLimitInfoEl = document.getElementById("rateLimitInfo");
const clearQueueButtonEl = document.getElementById("clearQueueButton");
const popupStatusEl = document.getElementById("popupStatus");

const tabProfilesEl = document.getElementById("tabProfiles");
const tabStatsEl = document.getElementById("tabStats");
const tabPanelProfilesEl = document.getElementById("tabPanelProfiles");
const tabPanelStatsEl = document.getElementById("tabPanelStats");
const profilesListEl = document.getElementById("profilesList");
const countryStatsEl = document.getElementById("countryStats");
const profilesSearchEl = document.getElementById("profilesSearch");
const profilesPaginationEl = document.getElementById("profilesPagination");
const profilesPreviousEl = document.getElementById("profilesPrevious");
const profilesNextEl = document.getElementById("profilesNext");
const profilesPageInfoEl = document.getElementById("profilesPageInfo");

let allCacheEntries = [];
let filteredCacheEntries = [];
let profilesPage = 0;
let profilesFilterTimer = null;
const PROFILES_PAGE_SIZE = 100;

// Initialize controls independently of storage and tab availability.
(async function initPopup() {
  initializeTabs();
  initializeProfilesSearch();
  initializeProfilesPagination();
  initializeClearQueueButton();
  try {
    const result = await browser.storage.local.get([TOGGLE_KEY]);
    const isEnabled =
      result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    updateToggle(isEnabled);
  } catch (e) {
    console.error("Error loading toggle state in popup:", e);
    popupStatusEl.textContent = "Unable to load extension state. Try toggling again.";
  } finally {
    toggleSwitchEl.disabled = false;
  }

  const manifest = browser.runtime.getManifest();
  const extVersion = document.getElementById("extVersion");
  if (extVersion) extVersion.textContent = `Version: ${manifest.version || "?"}`;
  await updateRateLimitInfo();
  await renderCacheViews();
})();

function initializeClearQueueButton() {
  if (!clearQueueButtonEl) return;

  clearQueueButtonEl.addEventListener("click", async () => {
    clearQueueButtonEl.disabled = true;
    popupStatusEl.textContent = "";
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tabs[0]?.id) throw new Error("No active tab available for clearing the queue");
      const response = await browser.tabs.sendMessage(tabs[0].id, {
        type: "clearPersistedQueue",
      });
      if (!response?.cleared) throw new Error("Queue clearing failed");
      popupStatusEl.textContent = "Queue cleared.";
      await updateRateLimitInfo();
    } catch (e) {
      console.error("Error clearing queue:", e);
      popupStatusEl.textContent = "Unable to clear the queue. Try again.";
    } finally {
      clearQueueButtonEl.disabled = false;
    }
  });
}

function initializeProfilesSearch() {
  if (!profilesSearchEl) return;

  profilesSearchEl.addEventListener("input", () => {
    clearTimeout(profilesFilterTimer);
    profilesFilterTimer = setTimeout(applyProfilesFilter, 100);
  });

  profilesSearchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      profilesSearchEl.value = "";
      applyProfilesFilter();
    }
  });
}

function applyProfilesFilter() {
  clearTimeout(profilesFilterTimer);
  if (allCacheEntries === null) return;
  const query = (profilesSearchEl?.value || "").trim().toLowerCase();
  filteredCacheEntries = !query ? allCacheEntries : allCacheEntries.filter((e) => {
    const username = String(e.username || "").toLowerCase();
    const location = String(e.location || "").toLowerCase();
    return username.includes(query) || location.includes(query);
  });

  profilesPage = 0;
  renderProfilesPage();
}

function initializeProfilesPagination() {
  profilesPreviousEl.addEventListener("click", () => {
    if (profilesPage === 0) return;
    profilesPage -= 1;
    renderProfilesPage();
  });
  profilesNextEl.addEventListener("click", () => {
    if ((profilesPage + 1) * PROFILES_PAGE_SIZE >= filteredCacheEntries.length) return;
    profilesPage += 1;
    renderProfilesPage();
  });
}

function renderProfilesPage() {
  const start = profilesPage * PROFILES_PAGE_SIZE;
  const end = Math.min(start + PROFILES_PAGE_SIZE, filteredCacheEntries.length);
  renderProfiles(filteredCacheEntries.slice(start, end), {
    isFiltered: Boolean(profilesSearchEl?.value.trim()),
  });
  profilesListEl.scrollTop = 0;
  profilesPaginationEl.hidden = filteredCacheEntries.length <= PROFILES_PAGE_SIZE;
  profilesPreviousEl.disabled = profilesPage === 0;
  profilesNextEl.disabled = end >= filteredCacheEntries.length;
  profilesPageInfoEl.textContent = `${start + 1}–${end} of ${filteredCacheEntries.length}`;
}

async function refreshCacheViews() {
  await renderCacheViews();
}

async function deleteCacheEntry(username) {
  const cleaned = typeof username === "string" ? username.trim() : "";
  if (!cleaned) return;

  popupStatusEl.textContent = "";
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tabs[0]?.id) {
      throw new Error("No active tab available for cache deletion");
    }

    const response = await browser.tabs.sendMessage(tabs[0].id, {
      type: "deleteCacheEntry",
      username: cleaned,
    });
    if (!response?.deleted) throw new Error("Cache deletion failed");

    await refreshCacheViews();
  } catch (e) {
    console.error("Error deleting cache entry:", e);
    popupStatusEl.textContent = "Unable to delete cached profile. Try again.";
  }
}

function initializeTabs() {
  if (!tabProfilesEl || !tabStatsEl) return;

  const setActive = (tab) => {
    const isProfiles = tab === "profiles";

    tabProfilesEl.classList.toggle("active", isProfiles);
    tabStatsEl.classList.toggle("active", !isProfiles);

    tabProfilesEl.setAttribute("aria-selected", String(isProfiles));
    tabStatsEl.setAttribute("aria-selected", String(!isProfiles));
    tabProfilesEl.tabIndex = isProfiles ? 0 : -1;
    tabStatsEl.tabIndex = isProfiles ? -1 : 0;

    if (tabPanelProfilesEl) tabPanelProfilesEl.hidden = !isProfiles;
    if (tabPanelStatsEl) tabPanelStatsEl.hidden = isProfiles;
  };

  tabProfilesEl.addEventListener("click", () => setActive("profiles"));
  tabStatsEl.addEventListener("click", () => setActive("stats"));

  for (const tab of [tabProfilesEl, tabStatsEl]) {
    tab.addEventListener("keydown", (event) => {
      let target;
      if (event.key === "Home") target = tabProfilesEl;
      else if (event.key === "End") target = tabStatsEl;
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        target = tab === tabProfilesEl ? tabStatsEl : tabProfilesEl;
      } else return;
      event.preventDefault();
      setActive(target === tabProfilesEl ? "profiles" : "stats");
      target.focus();
    });
  }
  setActive("profiles");
}

async function loadAllCacheEntries() {
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tabs[0]?.id) {
      return null;
    }

    const response = await browser.tabs.sendMessage(tabs[0].id, {
      type: "getAllCacheEntries",
    });

    if (response && Array.isArray(response.entries)) {
      return response.entries;
    }

    return null;
  } catch (e) {
    console.error("Error loading cache entries:", e);
    return null;
  }
}

async function renderCacheViews() {
  if (!profilesListEl || !countryStatsEl) return;

  cacheInfoEl.textContent = "Cached locations: Loading...";
  allCacheEntries = null;
  filteredCacheEntries = [];
  profilesPaginationEl.hidden = true;
  profilesListEl.textContent = "Loading...";
  countryStatsEl.textContent = "Loading...";

  const entries = await loadAllCacheEntries();

  if (entries === null) {
    cacheInfoEl.textContent = "Cached locations: Unable to load";
    profilesListEl.textContent = "Unable to load cached profiles.";
    countryStatsEl.textContent = "Unable to load cache statistics.";
    return;
  }

  allCacheEntries = [...entries].sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
  cacheInfoEl.textContent = `Cached locations: ${entries.length}`;

  applyProfilesFilter();
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

  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
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

    if (username) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "icon-button";
      deleteBtn.type = "button";
      deleteBtn.setAttribute("aria-label", `Delete @${username} from cache`);
      deleteBtn.title = "Delete from cache";

      deleteBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M4 6H20M16 6L15.7294 5.18807C15.4671 4.40125 15.3359 4.00784 15.0927 3.71698C14.8779 3.46013 14.6021 3.26132 14.2905 3.13878C13.9376 3 13.523 3 12.6936 3H11.3064C10.477 3 10.0624 3 9.70951 3.13878C9.39792 3.26132 9.12208 3.46013 8.90729 3.71698C8.66405 4.00784 8.53292 4.40125 8.27064 5.18807L8 6M6 6V18C6 19.6569 7.34315 21 9 21H15C16.6569 21 18 19.6569 18 18V6M10 10V17M14 10V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      deleteBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteBtn.disabled = true;
        try {
          await deleteCacheEntry(username);
        } finally {
          deleteBtn.disabled = false;
        }
      });

      row.appendChild(deleteBtn);
    }

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
  toggleSwitchEl.disabled = true;
  popupStatusEl.textContent = "";
  try {
    const result = await browser.storage.local.get([TOGGLE_KEY]);
    const currentState =
      result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    const newState = !currentState;

    await browser.storage.local.set({ [TOGGLE_KEY]: newState });
    updateToggle(newState);
    popupStatusEl.textContent = newState ? "Extension enabled." : "Extension disabled.";

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
    popupStatusEl.textContent = "Unable to change extension state. Try again.";
  } finally {
    toggleSwitchEl.disabled = false;
  }
});

function updateToggle(isEnabled) {
  toggleSwitchEl.setAttribute("aria-checked", String(isEnabled));
  if (isEnabled) {
    toggleSwitchEl.classList.add("enabled");
  } else {
    toggleSwitchEl.classList.remove("enabled");
  }
}
