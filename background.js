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
function updateIcon(tabId, url) {
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
  updateIcon(tab.id, tab.url);
});

// Listen for tab updates (URL changes)
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    updateIcon(tabId, changeInfo.url);
  }
});

// Listen for window focus changes
browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const tabs = await browser.tabs.query({ active: true, windowId });
  if (tabs[0]) {
    updateIcon(tabs[0].id, tabs[0].url);
  }
});

// On extension startup, update all visible tabs
(async function initAllTabs() {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    updateIcon(tab.id, tab.url);
  }
})();
