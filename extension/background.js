/**
 * background.js — Service Worker
 *
 * Keeps Tab Harbor pages in sync when tabs change.
 * The toolbar badge is intentionally kept empty.
 */

const TAB_HARBOR_BG_DEBUG = false;
if (TAB_HARBOR_BG_DEBUG)
  console.log(
    "[tab-harbor bg] Service worker loaded, registering event listeners...",
  );

// ─── Auto-close duplicate new tabs ───────────────────────────────────────────

// Tabs created within this window are exempt from duplicate-blank-tab cleanup:
// session restore creates many tabs in a burst and their navigation has not
// committed yet (url is empty), which would otherwise look like a pile of
// accidentally-opened blank new-tab pages and get closed.
const NEW_TAB_GRACE_PERIOD_MS = 5000;
const createdRecentlyAt = new Map(); // tabId -> timestamp
const graceTimers = new Map(); // tabId -> timeout id, one-shot post-grace check

function getNewTabUrls() {
  return new Set([
    chrome.runtime.getURL("index.html"),
    chrome.runtime.getURL("extension/index.html"),
  ]);
}

// Strip the query string (the focus-redirect appends ?focus=1 to the new-tab
// URL) and the hash so an extension new-tab page still matches its known URL.
function normalizeNewTabUrl(rawUrl = "") {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(rawUrl).split(/[?#]/)[0] || rawUrl;
  }
}

/**
 * scheduleGraceExpiryCheck(tabId)
 *
 * closeDuplicateNewTabs() only closes blank tabs whose grace period has
 * expired. A freshly created tab is exempt for NEW_TAB_GRACE_PERIOD_MS, so if
 * the user Ctrl+T's a new new-tab page next to an existing Tab Harbor page,
 * the check that runs at onCreated sees the new tab still in grace and does
 * nothing. This schedules one extra check after the grace window so the
 * duplicate is still caught once the exemption lapses.
 */
function scheduleGraceExpiryCheck(tabId) {
  if (graceTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    graceTimers.delete(tabId);
    createdRecentlyAt.delete(tabId);
    closeDuplicateNewTabs();
  }, NEW_TAB_GRACE_PERIOD_MS + 200);
  graceTimers.set(tabId, timer);
}

function clearGraceExpiryCheck(tabId) {
  const timer = graceTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(tabId);
  }
}

function isNewTabBlank(tab, newTabUrls) {
  // A discarded (sleeping) tab is never an accidentally-opened blank new-tab
  // page: session restore creates tabs and discards them so they start asleep,
  // and a discarded tab may carry an empty/uncommitted url.
  if (tab?.discarded) return false;
  const knownNewTabUrls =
    newTabUrls instanceof Set
      ? newTabUrls
      : new Set(Array.isArray(newTabUrls) ? newTabUrls : [newTabUrls]);
  const normalizedKnown = new Set(
    [...knownNewTabUrls].map((u) => normalizeNewTabUrl(u)),
  );
  const url = tab?.url || "";
  const pendingUrl = tab?.pendingUrl || "";
  const normalizedUrl = normalizeNewTabUrl(url);
  const normalizedPendingUrl = normalizeNewTabUrl(pendingUrl);

  // A tab whose URL is already an explicit new-tab page is not "in flight":
  // it IS a new tab, so it must count for duplicate cleanup immediately. Only
  // tabs with an empty/uncommitted URL (session-restore bursts that have not
  // navigated yet) get the grace-period exemption.
  const isExplicitNewTab =
    url === "chrome://newtab/" ||
    normalizedKnown.has(normalizedUrl) ||
    pendingUrl === "chrome://newtab/" ||
    normalizedKnown.has(normalizedPendingUrl);

  if (!isExplicitNewTab && tab?.id != null) {
    const createdAt = createdRecentlyAt.get(tab.id);
    if (createdAt != null && Date.now() - createdAt < NEW_TAB_GRACE_PERIOD_MS) {
      return false;
    }
    if (createdAt != null) createdRecentlyAt.delete(tab.id);
  }

  if (
    pendingUrl &&
    !normalizedKnown.has(normalizedPendingUrl) &&
    pendingUrl !== "chrome://newtab/"
  ) {
    return false;
  }
  return (
    isExplicitNewTab ||
    url === "" ||
    (tab.status === "loading" && !url)
  );
}

// Re-entrancy guard: onCreated, the post-grace timer, and onUpdated can all
// call closeDuplicateNewTabs within a few hundred ms of each other. Running
// two checks concurrently against the same tabs would issue duplicate
// chrome.tabs.remove calls. While one check is in flight we count how many
// more are owed and run them afterwards (once), so the newest tab state is
// still checked without removing the same tab id twice.
let duplicateCloseInFlight = false;
let duplicateCloseQueued = 0;

async function closeDuplicateNewTabs() {
  if (duplicateCloseInFlight) {
    duplicateCloseQueued += 1;
    return;
  }
  duplicateCloseInFlight = true;
  try {
    const stored = await chrome.storage.local.get("themePreferences");
    const prefs = stored.themePreferences || {};
    if (prefs.closeDuplicateNewTabsEnabled !== true) return;

    const newTabUrls = getNewTabUrls();
    const allTabs = await chrome.tabs.query({});
    const blankTabs = allTabs.filter((tab) => isNewTabBlank(tab, newTabUrls));

    if (blankTabs.length <= 1) return;

    // Keep the active tab; if none is active, keep the one with the largest id (newest)
    const activeTab = blankTabs.find((tab) => tab.active);
    const toKeep =
      activeTab || blankTabs.reduce((a, b) => (a.id > b.id ? a : b));
    const toClose = blankTabs
      .filter((tab) => tab.id !== toKeep.id)
      .map((tab) => tab.id);

    if (toClose.length > 0) await chrome.tabs.remove(toClose);
  } catch (err) {
    console.warn("[tab-harbor bg] closeDuplicateNewTabs error:", err.message);
  } finally {
    duplicateCloseInFlight = false;
    if (duplicateCloseQueued > 0) {
      duplicateCloseQueued = 0;
      void closeDuplicateNewTabs();
    }
  }
}

async function updateBadge() {
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Notify Tab Harbor pages when tabs change so they can refresh
async function notifyTabHarborPages(eventMeta = {}) {
  const message = {
    action: "tabs-changed",
    source: eventMeta.source || "tabs.changed",
    triggerTabId: eventMeta.triggerTabId ?? null,
  };

  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    if (err?.message && !err.message.includes("Receiving end does not exist")) {
      console.warn(
        "[tab-harbor bg] Error notifying Tab Harbor pages:",
        err.message,
      );
    }
  }
}

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge and notify Tab Harbor pages whenever a tab is opened
chrome.tabs.onCreated.addListener((tab) => {
  if (tab?.id != null) {
    createdRecentlyAt.set(tab.id, Date.now());
    scheduleGraceExpiryCheck(tab.id);
  }
  updateBadge();
  notifyTabHarborPages({ source: "tabs.onCreated", triggerTabId: tab?.id });
  closeDuplicateNewTabs();
});

// Update badge and notify Tab Harbor pages whenever a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  createdRecentlyAt.delete(tabId);
  clearGraceExpiryCheck(tabId);
  updateBadge();
  notifyTabHarborPages({ source: "tabs.onRemoved", triggerTabId: tabId });
});

// Update badge and notify Tab Harbor pages when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  updateBadge();
  notifyTabHarborPages({ source: "tabs.onUpdated", triggerTabId: tabId });

  // A tab that just committed a new-tab URL (chrome://newtab/ or the Tab
  // Harbor extension page) may have been created inside the grace window and
  // therefore skipped by the onCreated cleanup. Re-check now that its URL is
  // known so a Ctrl+T'd duplicate next to an existing Tab Harbor page is
  // still closed. The grace check itself already ran or is scheduled by
  // onCreated; this is a second, URL-driven opportunity.
  if (changeInfo?.url) {
    const urls = getNewTabUrls();
    const isNewTab = changeInfo.url === "chrome://newtab/" || urls.has(changeInfo.url);
    if (isNewTab) closeDuplicateNewTabs();
  }
});

// A tab can be replaced with a different tab id (OAuth/redirect flows,
// prerendering). Without this, pages keep chips for tab ids that no longer
// exist, and actions on those stale chips corrupt grouping state.
chrome.tabs.onReplaced.addListener((addedTabId) => {
  updateBadge();
  notifyTabHarborPages({ source: "tabs.onReplaced", triggerTabId: addedTabId });
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();

// ─── Test exports ────────────────────────────────────────────────────────────

globalThis.TabHarborBackground = {
  getNewTabUrls,
  isNewTabBlank,
  closeDuplicateNewTabs,
  // Test-only: reset the re-entrancy guard between test cases.
  _resetDuplicateCloseGuard: () => {
    duplicateCloseInFlight = false;
    duplicateCloseQueued = 0;
  },
};
