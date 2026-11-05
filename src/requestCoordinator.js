// Coordinate tabs only within the same cookie store and private-browsing context.
const SHARED_QUEUES_KEY = "account_request_queues";
const QUEUE_ALARM_PREFIX = "resume-account-queue:";
const queues = new Map();
let queueEnabled = true;
let legacyLeaseUntil = 0;

function scopeForTab(tab) {
  return `${tab.incognito ? "private" : "normal"}:${tab.cookieStoreId || "default"}`;
}

function getQueue(scope) {
  if (!queues.has(scope)) {
    queues.set(scope, {
      scope,
      pendingUsernames: new Set(),
      timer: null,
      state: {
        blockedUntil: 0, notBefore: legacyLeaseUntil, active: null, clearEpoch: 0,
        rateLimitInfo: { limit: null, remaining: null, resetTime: null, waitTime: null },
      },
    });
  }
  return queues.get(scope);
}

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
  const saved = await browser.storage.local.get([SHARED_QUEUES_KEY, "account_request_state", "extension_enabled"]);
  // The old global pending list has no container identity. Retain it untouched;
  // reloaded content scripts submit visible accounts to their correct queues.
  const legacyDeadline = saved.account_request_state?.active?.deadline;
  if (Number.isFinite(legacyDeadline) && legacyDeadline > Date.now() && legacyDeadline <= Date.now() + 20000) {
    legacyLeaseUntil = legacyDeadline;
  }
  for (const [scope, value] of Object.entries(saved[SHARED_QUEUES_KEY] || {})) {
    if (!scope.startsWith("normal:") && !scope.startsWith("private:")) continue;
    const queue = getQueue(scope);
    for (const name of Array.isArray(value?.pending) ? value.pending : []) {
      if (validScreenName(name)) queue.pendingUsernames.add(name.toLowerCase());
    }
    const state = value?.state;
    if (!state) continue;
    for (const key of ["blockedUntil", "notBefore"]) {
      if (Number.isFinite(state[key]) && state[key] >= 0 && state[key] <= Date.now() + 86400000) {
        queue.state[key] = state[key];
      }
    }
    if (Number.isSafeInteger(state.clearEpoch) && state.clearEpoch >= 0) queue.state.clearEpoch = state.clearEpoch;
    if (validSharedRateLimit(state.rateLimitInfo)) queue.state.rateLimitInfo = state.rateLimitInfo;
    const active = state.active;
    if (active && validScreenName(active.screenName) && typeof active.token === "string" &&
        Number.isInteger(active.tabId) && active.tabId >= 0 && Number.isFinite(active.deadline) &&
        active.deadline > Date.now() && active.deadline <= Date.now() + 20000) queue.state.active = active;
  }
  queueEnabled = saved.extension_enabled ?? true;
  await browser.alarms.clear("resume-account-queue");
})();

// Serialize mutations, including storage writes, so no tab can overwrite another.
let queueWork = Promise.resolve();
function coordinate(work) {
  const result = queueWork.then(() => queueReady).then(work);
  queueWork = result.catch((error) => console.error("Account queue error:", error));
  return result;
}

async function saveQueues() {
  await browser.storage.local.set({
    [SHARED_QUEUES_KEY]: Object.fromEntries(Array.from(queues, ([scope, queue]) => [scope, {
      pending: Array.from(queue.pendingUsernames), state: queue.state,
    }])),
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

async function broadcastQueueMessage(queue, message) {
  const tabs = (await browser.tabs.query({ url: "https://x.com/*" })).filter((tab) => scopeForTab(tab) === queue.scope);
  await Promise.allSettled(tabs.map((tab) => sendQueueMessage(tab.id, message)));
}

async function wakeQueueAt(queue, when) {
  clearTimeout(queue.timer);
  queue.timer = null;
  const alarmName = QUEUE_ALARM_PREFIX + queue.scope;
  if (when === null) {
    await browser.alarms.clear(alarmName);
    return;
  }
  // The alarm survives worker suspension; a short timer preserves 200 ms pacing.
  await browser.alarms.create(alarmName, { when: Math.max(when, Date.now() + 30000) });
  if (when - Date.now() < 30000) {
    queue.timer = setTimeout(() => { coordinate(() => processSharedQueue(queue)); }, Math.max(0, when - Date.now()));
  }
}

async function cancelSharedRequest(queue) {
  const queueState = queue.state;
  const active = queueState.active;
  if (!active) return;
  active.cancelled = true;
  await saveQueues();
  try {
    const tab = await browser.tabs.get(active.tabId);
    if (scopeForTab(tab) !== queue.scope) return;
    const response = await sendQueueMessage(active.tabId, { type: "cancelSharedAccountQuery", token: active.token });
    if (response?.cancelled) queueState.active = null;
  } catch (error) {
    // Keep the lease until its deadline if cancellation could not be confirmed.
  }
  await saveQueues();
}

async function processSharedQueue(queue) {
  const { state: queueState, pendingUsernames } = queue;
  const now = Date.now();
  if (queueState.active) {
    if (queueState.active.deadline > now) {
      await wakeQueueAt(queue, queueState.active.deadline);
      return;
    }
    await cancelSharedRequest(queue);
    queueState.active = null;
    queueState.notBefore = now + 200;
    await saveQueues();
  }
  if (!queueEnabled || pendingUsernames.size === 0) {
    await wakeQueueAt(queue, null);
    return;
  }
  const next = Math.max(queueState.blockedUntil, queueState.notBefore);
  if (next > now) {
    await wakeQueueAt(queue, next);
    return;
  }

  const screenName = pendingUsernames.values().next().value;
  const tabs = (await browser.tabs.query({ url: "https://x.com/*" })).filter((tab) => scopeForTab(tab) === queue.scope);
  if (tabs.length === 0) {
    // A tab in this context will send resumeAccountQueue when it becomes ready.
    await wakeQueueAt(queue, null);
    return;
  }
  for (const tab of tabs) {
    queueState.active = { screenName, tabId: tab.id, token: crypto.randomUUID(), deadline: Date.now() + 20000 };
    await saveQueues();
    let response;
    try {
      response = await sendQueueMessage(tab.id, { type: "executeSharedAccountQuery", scope: queue.scope, ...queueState.active });
    } catch (error) {
      response = { accepted: false };
    }
    if (response === null || response?.accepted) {
      // An unacknowledged dispatch may have started; never overlap its lease.
      await wakeQueueAt(queue, queueState.active.deadline);
      return;
    }
    queueState.active = null;
  }
  queueState.notBefore = Date.now() + 30000;
  await saveQueues();
  await wakeQueueAt(queue, queueState.notBefore);
}

async function completeSharedRequest(queue, message, tabId) {
  const { state: queueState, pendingUsernames } = queue;
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
      const response = { type: "sharedAccountQueryResult", scope: queue.scope, screenName: active.screenName,
        account: status ? result.account : null,
        cachedAt: Number.isFinite(result.cachedAt) && result.cachedAt >= 0 && result.cachedAt <= Date.now()
          ? result.cachedAt : Date.now(),
        error: result.error || (status ? null : "Invalid account response") };
      pendingUsernames.delete(active.screenName);
      await broadcastQueueMessage(queue, response);
    }
  }
  queueState.active = null;
  queueState.notBefore = Date.now() + 200;
  await saveQueues();
  await processSharedQueue(queue);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const types = ["queueAccountQuery", "resumeAccountQueue", "accountQueryComplete", "getSharedRateLimitInfo", "clearSharedAccountQueue"];
  if (!message || !types.includes(message.type)) return;
  const fromTab = sender.frameId === 0 && Number.isInteger(sender.tab?.id) && sender.url?.startsWith("https://x.com/");
  if (["queueAccountQuery", "resumeAccountQueue", "accountQueryComplete"].includes(message.type) && !fromTab) return;
  coordinate(async () => {
    const tabId = fromTab ? sender.tab.id : message.tabId;
    if (!Number.isInteger(tabId)) throw new Error("No active X tab available");
    const tab = await browser.tabs.get(tabId);
    if (!tab.url?.startsWith("https://x.com/")) throw new Error("An X tab is required");
    const queue = getQueue(scopeForTab(tab));
    const { state: queueState, pendingUsernames } = queue;
    if (message.type === "queueAccountQuery") {
      if (!validScreenName(message.screenName)) throw new Error("Invalid username");
      const name = message.screenName.toLowerCase();
      pendingUsernames.add(name);
      await saveQueues();
      await processSharedQueue(queue);
      return { queued: true, scope: queue.scope };
    }
    if (message.type === "accountQueryComplete") {
      await completeSharedRequest(queue, message, sender.tab.id);
      return { received: true };
    }
    if (message.type === "getSharedRateLimitInfo") {
      return { scope: queue.scope, ...queueState.rateLimitInfo, queueDistinct: pendingUsernames.size, inFlight: queueState.active ? 1 : 0 };
    }
    if (message.type === "clearSharedAccountQueue") {
      pendingUsernames.clear();
      queueState.clearEpoch += 1;
      if (queueState.active) queueState.active.cancelled = true;
      await saveQueues();
      await cancelSharedRequest(queue);
      await broadcastQueueMessage(queue, { type: "sharedAccountQueueCleared", scope: queue.scope, clearEpoch: queueState.clearEpoch });
      await processSharedQueue(queue);
      return { cleared: true };
    }
    // A newly ready tab can resume a queue parked while no X tab was available.
    queueState.notBefore = Math.min(queueState.notBefore, Date.now() + 200);
    await saveQueues();
    await processSharedQueue(queue);
    return { ready: true, scope: queue.scope };
  }).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});

async function processSharedQueues() {
  for (const queue of queues.values()) await processSharedQueue(queue);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.extension_enabled) return;
  coordinate(async () => {
    queueEnabled = changes.extension_enabled.newValue ?? true;
    if (!queueEnabled) {
      for (const queue of queues.values()) await cancelSharedRequest(queue);
    }
    await processSharedQueues();
  });
});
browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(QUEUE_ALARM_PREFIX)) return;
  coordinate(() => {
    const queue = queues.get(alarm.name.slice(QUEUE_ALARM_PREFIX.length));
    if (queue) return processSharedQueue(queue);
  });
});
// Recreate each container's alarm on every background start.
coordinate(processSharedQueues);
