// One queue owns persistence and API backoff for every X tab.
const SHARED_QUEUE_KEY = "pending_usernames_queue";
const SHARED_STATE_KEY = "account_request_state";
const QUEUE_ALARM = "resume-account-queue";
const pendingUsernames = new Set();
let queueState = {
  blockedUntil: 0,
  notBefore: 0,
  active: null,
  clearEpoch: 0,
  rateLimitInfo: { limit: null, remaining: null, resetTime: null, waitTime: null },
};
let queueEnabled = true;
let queueTimer = null;

function validScreenName(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_]{1,15}$/.test(value);
}

function validSharedRateLimit(info) {
  return info && [info.limit, info.remaining, info.resetTime, info.waitTime].every(
    (value) => value === null || (Number.isSafeInteger(value) && value >= 0)
  ) && (info.limit === null || info.remaining === null || info.remaining <= info.limit) &&
    (info.resetTime === null || info.resetTime <= Math.floor(Date.now() / 1000) + 86400) &&
    (info.waitTime === null || info.waitTime <= 86400000);
}

const queueReady = (async () => {
  const saved = await browser.storage.local.get([SHARED_QUEUE_KEY, SHARED_STATE_KEY, "extension_enabled"]);
  for (const name of Array.isArray(saved[SHARED_QUEUE_KEY]) ? saved[SHARED_QUEUE_KEY] : []) {
    if (validScreenName(name)) pendingUsernames.add(name.toLowerCase());
  }
  const state = saved[SHARED_STATE_KEY];
  if (state) {
    for (const key of ["blockedUntil", "notBefore"]) {
      if (Number.isFinite(state[key]) && state[key] >= 0 && state[key] <= Date.now() + 86400000) {
        queueState[key] = state[key];
      }
    }
    if (Number.isSafeInteger(state.clearEpoch) && state.clearEpoch >= 0) queueState.clearEpoch = state.clearEpoch;
    if (validSharedRateLimit(state.rateLimitInfo)) queueState.rateLimitInfo = state.rateLimitInfo;
    const active = state.active;
    if (active && validScreenName(active.screenName) && typeof active.token === "string" &&
        Number.isInteger(active.tabId) && active.tabId >= 0 && Number.isFinite(active.deadline) && active.deadline > Date.now() && active.deadline <= Date.now() + 20000) {
      queueState.active = active;
    }
  }
  queueEnabled = saved.extension_enabled ?? true;
})();

// Serialize mutations, including storage writes, so no tab can overwrite another.
let queueWork = Promise.resolve();
function coordinate(work) {
  const result = queueWork.then(() => queueReady).then(work);
  queueWork = result.catch((error) => console.error("Account queue error:", error));
  return result;
}

async function saveQueue() {
  await browser.storage.local.set({
    [SHARED_QUEUE_KEY]: Array.from(pendingUsernames),
    [SHARED_STATE_KEY]: queueState,
  });
}

async function sendQueueMessage(tabId, message) {
  let timeout;
  try {
    return await Promise.race([
      browser.tabs.sendMessage(tabId, message),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 1000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function broadcastQueueMessage(message) {
  const tabs = await browser.tabs.query({ url: "https://x.com/*" });
  await Promise.allSettled(tabs.map((tab) => sendQueueMessage(tab.id, message)));
}

async function wakeQueueAt(when) {
  clearTimeout(queueTimer);
  queueTimer = null;
  if (when === null) {
    await browser.alarms.clear(QUEUE_ALARM);
    return;
  }
  // The alarm survives worker suspension; a short timer preserves 200 ms pacing.
  await browser.alarms.create(QUEUE_ALARM, { when: Math.max(when, Date.now() + 30000) });
  if (when - Date.now() < 30000) {
    queueTimer = setTimeout(() => { coordinate(processSharedQueue); }, Math.max(0, when - Date.now()));
  }
}

async function cancelSharedRequest() {
  const active = queueState.active;
  if (!active) return;
  active.cancelled = true;
  await saveQueue();
  try {
    const response = await sendQueueMessage(active.tabId, { type: "cancelSharedAccountQuery", token: active.token });
    if (response?.cancelled) queueState.active = null;
  } catch (error) {
    // Keep the lease until its deadline if cancellation could not be confirmed.
  }
  await saveQueue();
}

async function processSharedQueue() {
  const now = Date.now();
  if (queueState.active) {
    if (queueState.active.deadline > now) {
      await wakeQueueAt(queueState.active.deadline);
      return;
    }
    await cancelSharedRequest();
    queueState.active = null;
    queueState.notBefore = now + 200;
    await saveQueue();
  }
  if (!queueEnabled || pendingUsernames.size === 0) {
    await wakeQueueAt(null);
    return;
  }
  const next = Math.max(queueState.blockedUntil, queueState.notBefore);
  if (next > now) {
    await wakeQueueAt(next);
    return;
  }

  const screenName = pendingUsernames.values().next().value;
  const tabs = await browser.tabs.query({ url: "https://x.com/*" });
  for (const tab of tabs) {
    queueState.active = { screenName, tabId: tab.id, token: crypto.randomUUID(), deadline: Date.now() + 20000 };
    await saveQueue();
    let response;
    try {
      response = await sendQueueMessage(tab.id, { type: "executeSharedAccountQuery", ...queueState.active });
    } catch (error) {
      response = { accepted: false };
    }
    if (response === null || response?.accepted) {
      // An unacknowledged dispatch may have started; never overlap its lease.
      await wakeQueueAt(queueState.active.deadline);
      return;
    }
    queueState.active = null;
  }
  queueState.notBefore = Date.now() + 30000;
  await saveQueue();
  await wakeQueueAt(queueState.notBefore);
}

async function completeSharedRequest(message, tabId) {
  const active = queueState.active;
  if (!active || active.token !== message.token || active.tabId !== tabId || active.screenName !== message.screenName) return;
  const result = message.result;
  if (!result || typeof result !== "object") return;
  if (!active.cancelled && !result.cancelled) {
    if (typeof result.isRateLimited !== "boolean" ||
        !(result.error === undefined || (typeof result.error === "string" && result.error.length > 0 && result.error.length <= 500))) return;
    if (validSharedRateLimit(result.rateLimitInfo)) {
      queueState.rateLimitInfo = result.rateLimitInfo;
      if (result.rateLimitInfo.remaining === 0) {
        queueState.blockedUntil = result.rateLimitInfo.resetTime * 1000 > Date.now()
          ? result.rateLimitInfo.resetTime * 1000 : Date.now() + 120000;
      }
    }
    if (result.isRateLimited) {
      queueState.blockedUntil = Math.max(queueState.blockedUntil, Date.now() + 120000);
      const reset = queueState.rateLimitInfo.resetTime * 1000;
      if (reset > Date.now()) queueState.blockedUntil = reset;
    } else {
      const status = cacheManager.getAccountStatus(result.account);
      const response = { type: "sharedAccountQueryResult", screenName: active.screenName,
        account: status ? result.account : null,
        cachedAt: Number.isFinite(result.cachedAt) && result.cachedAt >= 0 && result.cachedAt <= Date.now()
          ? result.cachedAt : Date.now(),
        error: result.error || (status ? null : "Invalid account response") };
      pendingUsernames.delete(active.screenName);
      await broadcastQueueMessage(response);
    }
  }
  queueState.active = null;
  queueState.notBefore = Date.now() + 200;
  await saveQueue();
  await processSharedQueue();
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const types = ["queueAccountQuery", "resumeAccountQueue", "accountQueryComplete", "getSharedRateLimitInfo", "clearSharedAccountQueue"];
  if (!message || !types.includes(message.type)) return;
  const fromTab = sender.frameId === 0 && Number.isInteger(sender.tab?.id) && sender.url?.startsWith("https://x.com/");
  if (["queueAccountQuery", "resumeAccountQueue", "accountQueryComplete"].includes(message.type) && !fromTab) return;
  coordinate(async () => {
    if (message.type === "queueAccountQuery") {
      if (!validScreenName(message.screenName)) throw new Error("Invalid username");
      const name = message.screenName.toLowerCase();
      pendingUsernames.add(name);
      await saveQueue();
      await processSharedQueue();
      return { queued: true };
    }
    if (message.type === "accountQueryComplete") {
      await completeSharedRequest(message, sender.tab.id);
      return { received: true };
    }
    if (message.type === "getSharedRateLimitInfo") {
      return { ...queueState.rateLimitInfo, queueDistinct: pendingUsernames.size, inFlight: queueState.active ? 1 : 0 };
    }
    if (message.type === "clearSharedAccountQueue") {
      pendingUsernames.clear();
      queueState.clearEpoch += 1;
      if (queueState.active) queueState.active.cancelled = true;
      await saveQueue();
      await cancelSharedRequest();
      await processSharedQueue();
      return { cleared: true };
    }
    // A newly ready tab can resume a queue parked while no X tab was available.
    queueState.notBefore = Math.min(queueState.notBefore, Date.now() + 200);
    await saveQueue();
    await processSharedQueue();
    return { ready: true };
  }).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.extension_enabled) return;
  coordinate(async () => {
    queueEnabled = changes.extension_enabled.newValue ?? true;
    if (!queueEnabled) await cancelSharedRequest();
    await processSharedQueue();
  });
});
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) coordinate(processSharedQueue);
});
// Recreate alarms on every worker start; their persistence differs by browser.
coordinate(processSharedQueue);
