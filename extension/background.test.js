'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Track calls to chrome.tabs.remove
let removedTabIds = [];
let storageData = {};

// Controlled timers: background.js schedules a one-shot post-grace check for
// every created tab. Real setTimeout would keep the test process alive for
// NEW_TAB_GRACE_PERIOD_MS; record callbacks instead so tests can fire them
// deterministically (or leave them pending).
const pendingTimers = new Map(); // id -> { fn, delay }
let nextTimerId = 1;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = (fn, delay) => {
  const id = nextTimerId++;
  pendingTimers.set(id, { fn, delay });
  return id;
};
global.clearTimeout = (id) => {
  pendingTimers.delete(id);
};
function firePendingTimers() {
  const snapshot = [...pendingTimers.values()];
  pendingTimers.clear();
  for (const { fn } of snapshot) fn();
}

globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: path => `chrome-extension://test-extension-id/${path}`,
  },
  tabs: {
    query: async () => [],
    remove: async ids => { removedTabIds = removedTabIds.concat(ids); },
  },
  storage: {
    local: {
      get: async key => ({ [key]: storageData[key] || {} }),
    },
  },
  action: {
    setBadgeText: async () => {},
  },
  runtime: {
    id: 'test-extension-id',
    getURL: path => `chrome-extension://test-extension-id/${path}`,
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
  },
  tabs: {
    query: async () => [],
    remove: async ids => { removedTabIds = removedTabIds.concat(ids); },
    onCreated: { addListener: (fn) => { globalThis.__tabHarborOnCreated = fn; } },
    onRemoved: { addListener: (fn) => { globalThis.__tabHarborOnRemoved = fn; } },
    onUpdated: { addListener: (fn) => { globalThis.__tabHarborOnUpdated = fn; } },
    onReplaced: { addListener: () => {} },
  },
  action: {
    setBadgeText: async () => {},
  },
  runtime: {
    id: 'test-extension-id',
    getURL: path => `chrome-extension://test-extension-id/${path}`,
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: async () => {},
  },
};

require('./background.js');

const { isNewTabBlank, closeDuplicateNewTabs } = globalThis.TabHarborBackground;

// ─── isNewTabBlank ────────────────────────────────────────────────────────

const EXT_URL = 'chrome-extension://test-extension-id/index.html';
const ROOT_MANIFEST_EXT_URL = 'chrome-extension://test-extension-id/extension/index.html';

test('isNewTabBlank matches chrome://newtab/', () => {
  assert.equal(isNewTabBlank({ url: 'chrome://newtab/' }, EXT_URL), true);
});

test('isNewTabBlank matches extension index.html', () => {
  assert.equal(isNewTabBlank({ url: EXT_URL }, EXT_URL), true);
});

test('isNewTabBlank matches extension page with the focus-redirect query', () => {
  // focus-redirect.js appends ?focus=1 to the new-tab URL; the blank-tab
  // cleanup must still recognize the page.
  assert.equal(isNewTabBlank({ url: `${EXT_URL}?focus=1` }, EXT_URL), true);
  assert.equal(isNewTabBlank({ url: `${ROOT_MANIFEST_EXT_URL}?focus=1` }, [EXT_URL, ROOT_MANIFEST_EXT_URL]), true);
});

test('isNewTabBlank matches extension/index.html from root manifest entry', () => {
  assert.equal(isNewTabBlank({ url: ROOT_MANIFEST_EXT_URL }, [EXT_URL, ROOT_MANIFEST_EXT_URL]), true);
});

test('isNewTabBlank matches empty url', () => {
  assert.equal(isNewTabBlank({ url: '' }, EXT_URL), true);
});

test('isNewTabBlank matches loading tab with no url', () => {
  assert.equal(isNewTabBlank({ url: undefined, status: 'loading' }, EXT_URL), true);
});

test('isNewTabBlank does not match loading restored tab with normal pendingUrl', () => {
  assert.equal(isNewTabBlank({ url: undefined, pendingUrl: 'https://example.com', status: 'loading' }, EXT_URL), false);
});

test('isNewTabBlank matches loading new tab with new-tab pendingUrl', () => {
  assert.equal(isNewTabBlank({ url: undefined, pendingUrl: ROOT_MANIFEST_EXT_URL, status: 'loading' }, [EXT_URL, ROOT_MANIFEST_EXT_URL]), true);
});

test('isNewTabBlank does not match normal url', () => {
  assert.equal(isNewTabBlank({ url: 'https://example.com' }, EXT_URL), false);
});

test('isNewTabBlank does not match loading tab with url', () => {
  assert.equal(isNewTabBlank({ url: 'https://example.com', status: 'loading' }, EXT_URL), false);
});

// ─── closeDuplicateNewTabs ────────────────────────────────────────────────

test('closeDuplicateNewTabs does nothing when feature is disabled', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: false } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: true },
    { id: 2, url: 'chrome://newtab/', active: false },
  ];
  await closeDuplicateNewTabs();
  assert.deepEqual(removedTabIds, []);
});

test('closeDuplicateNewTabs does nothing when preference is missing', async () => {
  storageData = { themePreferences: {} };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: true },
    { id: 2, url: 'chrome://newtab/', active: false },
  ];
  await closeDuplicateNewTabs();
  assert.deepEqual(removedTabIds, []);
});

test('closeDuplicateNewTabs closes duplicate blank tabs when enabled', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: false },
    { id: 2, url: 'chrome://newtab/', active: true },
    { id: 3, url: 'https://example.com', active: false },
  ];
  await closeDuplicateNewTabs();
  assert.deepEqual(removedTabIds, [1]);
});

test('closeDuplicateNewTabs keeps active tab', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 10, url: EXT_URL, active: false },
    { id: 20, url: 'chrome://newtab/', active: true },
    { id: 30, url: '', active: false },
  ];
  await closeDuplicateNewTabs();
  // Should keep id=20 (active), close 10 and 30
  assert.deepEqual(removedTabIds, [10, 30]);
});

test('closeDuplicateNewTabs keeps newest tab when none is active', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 5, url: 'chrome://newtab/', active: false },
    { id: 15, url: 'chrome://newtab/', active: false },
  ];
  await closeDuplicateNewTabs();
  // Should keep id=15 (largest), close id=5
  assert.deepEqual(removedTabIds, [5]);
});

test('closeDuplicateNewTabs does nothing with a single blank tab', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: true },
    { id: 2, url: 'https://example.com', active: false },
  ];
  await closeDuplicateNewTabs();
  assert.deepEqual(removedTabIds, []);
});

test('closeDuplicateNewTabs handles mixed blank tab types', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: false },
    { id: 2, url: EXT_URL, active: true },
    { id: 3, url: '', active: false },
    { id: 4, url: undefined, status: 'loading', active: false },
  ];
  await closeDuplicateNewTabs();
  // Keep id=2 (active), close 1, 3, 4
  assert.deepEqual(removedTabIds, [1, 3, 4]);
});

test('closeDuplicateNewTabs treats root manifest new tab pages as blank tabs', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: ROOT_MANIFEST_EXT_URL, active: false },
    { id: 2, url: 'chrome://newtab/', active: true },
  ];
  await closeDuplicateNewTabs();
  assert.deepEqual(removedTabIds, [1]);
});

test('closeDuplicateNewTabs preserves restored tabs while their final URLs are pending', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: true },
    { id: 2, url: undefined, pendingUrl: 'https://example.com/a', status: 'loading', active: false },
    { id: 3, url: undefined, pendingUrl: 'https://example.com/b', status: 'loading', active: false },
  ];
  await closeDuplicateNewTabs();
  assert.deepEqual(removedTabIds, []);
});

test('isNewTabBlank never matches a discarded (sleeping) tab even with an empty url', () => {
  // Session restore discards freshly-created tabs so they start asleep; a
  // discarded tab may carry an empty/uncommitted url. It must not be treated
  // as an accidentally-opened blank new-tab page.
  assert.equal(isNewTabBlank({ url: '', discarded: true }, EXT_URL), false);
  assert.equal(isNewTabBlank({ url: undefined, status: 'loading', discarded: true }, EXT_URL), false);
  assert.equal(isNewTabBlank({ url: 'chrome://newtab/', discarded: true }, EXT_URL), false);
  // Non-discarded blank tabs are still matched as before.
  assert.equal(isNewTabBlank({ url: '', discarded: false }, EXT_URL), true);
});

test('closeDuplicateNewTabs never closes discarded (sleeping) tabs', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: true },
    // Restore-created tabs that were discarded right away: empty urls, asleep.
    { id: 2, url: '', discarded: true, active: false },
    { id: 3, url: '', discarded: true, active: false },
    { id: 4, url: undefined, status: 'loading', discarded: true, active: false },
  ];
  await closeDuplicateNewTabs();
  // Only the genuine blank new-tab page (id 1, kept active) is in play; the
  // discarded tabs are never closed.
  assert.deepEqual(removedTabIds, []);
});

test('closeDuplicateNewTabs exempts freshly-created tabs within the grace period', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  // Simulate the background's own onCreated bookkeeping: a restore batch just
  // created tabs 2 and 3 whose navigation has not committed (empty url).
  if (typeof globalThis.__tabHarborOnCreated === 'function') {
    globalThis.__tabHarborOnCreated({ id: 2, url: '' });
    globalThis.__tabHarborOnCreated({ id: 3, url: '' });
  }
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: true },
    { id: 2, url: '', active: false },
    { id: 3, url: '', active: false },
  ];
  await closeDuplicateNewTabs();
  // Freshly-created tabs are exempt (they may still be committing their
  // navigation); only the genuine blank tab 1 remains and it is the active
  // one, so nothing is closed.
  assert.deepEqual(removedTabIds, []);
});

// ─── Grace-expiry re-check + onUpdated/onRemoved cleanup ─────────────────────

test('Ctrl+T new-tab page with an explicit URL closes the older duplicate immediately', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  // Existing Tab Harbor page in another tab; user Ctrl+T's a new one on top.
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: EXT_URL, active: false },
    { id: 2, url: 'chrome://newtab/', active: true }, // fresh, in grace
  ];
  // Simulate the onCreated hook firing for the new tab (records grace start +
  // schedules the expiry check).
  if (typeof globalThis.__tabHarborOnCreated === 'function') {
    globalThis.__tabHarborOnCreated({ id: 2, url: '' });
  }
  // A Ctrl+T'd new-tab page with an explicit new-tab URL is not exempt from
  // cleanup: the duplicate is closed immediately, not after the grace window.
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: EXT_URL, active: false },
    { id: 2, url: 'chrome://newtab/', active: true },
  ];
  // onCreated already triggered an async check; let it settle.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  // Drain any pending grace-expiry timer so it cannot leak into later tests.
  firePendingTimers();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  // The active new tab (2) is kept; the older duplicate page (1) closes.
  // chrome.tabs.remove is idempotent for already-closed ids, so repeated
  // removals of the same tab are harmless; assert the set of closed tabs.
  assert.deepEqual([...new Set(removedTabIds)], [1]);
});

test('onRemoved clears a created tab from bookkeeping so it is not double-checked', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  if (typeof globalThis.__tabHarborOnCreated === 'function') {
    // Simulate a tab that is created then quickly closed; firing its newly
    // pending grace expiry must not throw or close anything.
    globalThis.__tabHarborOnCreated({ id: 9, url: '' });
  }
  if (typeof globalThis.__tabHarborOnRemoved === 'function') {
    globalThis.__tabHarborOnRemoved(9);
  }
  firePendingTimers();
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: 'chrome://newtab/', active: true },
  ];
  await closeDuplicateNewTabs();
  assert.deepEqual(removedTabIds, []);
});

test('onUpdated with a committed new-tab URL triggers the duplicate check', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  // Scenario: one Tab Harbor page exists; a new tab is created but its URL is
  // still empty (uncommitted). At onCreated the cleanup sees only the old page
  // (single blank) and does nothing.
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: EXT_URL, active: true },
    { id: 2, url: '', active: false },
  ];
  if (typeof globalThis.__tabHarborOnCreated === 'function') {
    globalThis.__tabHarborOnCreated({ id: 2, url: '' });
  }
  await closeDuplicateNewTabs();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  // The uncommitted tab 2 (empty url) is still in its grace window → the
  // cleanup keeps the only committed blank page and closes nothing.
  assert.deepEqual(removedTabIds, []);
  // Now the tab commits an explicit new-tab URL: it is a real new tab, so the
  // onUpdated hook re-runs the cleanup, which closes the older duplicate.
  globalThis.chrome.tabs.query = async () => [
    { id: 1, url: EXT_URL, active: false },
    { id: 2, url: 'chrome://newtab/', active: true },
  ];
  if (typeof globalThis.__tabHarborOnUpdated === 'function') {
    globalThis.__tabHarborOnUpdated(2, { url: 'chrome://newtab/' });
  }
  // Let the async check settle.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  // Drain any pending grace-expiry timer so it cannot leak into later tests.
  firePendingTimers();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  // The active new tab (2) is kept; the older duplicate page (1) closes.
  assert.deepEqual([...new Set(removedTabIds)], [1]);
});
