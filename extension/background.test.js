'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Track calls to chrome.tabs.remove
let removedTabIds = [];
let storageData = {};

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
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
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

test('duplicate blank tab created beside another blank tab is deduped once the grace expires (F3)', async () => {
  storageData = { themePreferences: { closeDuplicateNewTabsEnabled: true } };
  removedTabIds = [];
  globalThis.chrome.tabs.query = async () => [
    // Pre-existing genuine blank tab plus a freshly created duplicate; id 4
    // is a restore-created discarded tab that must stay protected even after
    // the grace expires.
    { id: 1, url: 'chrome://newtab/', active: false },
    { id: 2, url: 'chrome://newtab/', active: true },
    { id: 4, url: '', discarded: true, active: false },
  ];
  // The onCreated listener arms the grace and fires its OWN un-awaited
  // cleanup pass. Drain it with a macrotask boundary before asserting, so no
  // in-flight pass can straddle the later reconciliation.
  globalThis.__tabHarborOnCreated({ id: 2, url: 'chrome://newtab/' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await closeDuplicateNewTabs();
  // Tab 2 is shielded by the grace, so nothing can be closed yet.
  assert.deepEqual(removedTabIds, []);
  // Settle the armed post-grace reconciliation (test seam): registry is
  // cleared to simulate the grace having elapsed, then cleanup re-runs.
  await globalThis.TabHarborBackground.runPostGraceReconcileForTest();
  // The grace has expired: only the non-active genuine blank (id 1) closes;
  // the active duplicate (id 2) and the discarded restore tab (id 4) remain.
  assert.deepEqual(removedTabIds, [1]);
});
