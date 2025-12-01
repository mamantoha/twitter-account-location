// background.js for Twitter Account Location extension
// Handles icon enable/disable based on active tab

// Helper: check if a URL is a Twitter/X domain
function isTwitterUrl(url) {
  return (
    url &&
    (url.startsWith("https://twitter.com/") || url.startsWith("https://x.com/"))
  );
}

// Update icon for a given tab
function updateState(tabId, url) {
  // Also notify content script to check enabled state and clean up if needed
  if (isTwitterUrl(url)) {
    browser.tabs.sendMessage(tabId, { type: "checkExtensionEnabled" }).catch(() => {});
  }

  if (!isTwitterUrl(url)) {
    // Disable icon on non-Twitter tabs
    browser.action.disable(tabId);
    return;
  }
  // Enable icon on Twitter tabs
  browser.action.enable(tabId);
}

// Listen for tab activation
browser.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await browser.tabs.get(activeInfo.tabId);
  updateState(tab.id, tab.url);
});

// Listen for tab updates (URL changes)
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
  updateState(tabId, changeInfo.url);
  }
});

// Listen for window focus changes
browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const tabs = await browser.tabs.query({ active: true, windowId });
  if (tabs[0]) {
  updateState(tabs[0].id, tabs[0].url);
  }
});

// On extension startup, update all visible tabs
(async function initAllTabs() {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
  updateState(tab.id, tab.url);
  }
})();
