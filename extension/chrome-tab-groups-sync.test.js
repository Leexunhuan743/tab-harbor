'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function createEventEmitter() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

// Mock chrome APIs before loading the module
const mockStorage = {};
const mockSessionStorage = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const key = Array.isArray(keys) ? keys[0] : keys;
        return { [key]: mockStorage[key] ?? undefined };
      },
      set: async (items) => {
        Object.assign(mockStorage, items);
      },
      remove: async (keys) => {
        for (const key of [].concat(keys)) {
          delete mockStorage[key];
        }
      },
    },
    session: {
      get: async (key) => ({ [key]: mockSessionStorage[key] }),
      set: async (items) => {
        Object.assign(mockSessionStorage, items);
      },
      remove: async (keys) => {
        for (const key of [].concat(keys)) {
          delete mockSessionStorage[key];
        }
      },
    },
  },
  tabs: {
    group: async (opts) => 0,
    get: async () => ({ id: 0, groupId: -1, windowId: 0 }),
    move: async () => {},
    ungroup: async () => {},
    query: async (opts) => opts?.groupId != null ? [] : [],
    onAttached: createEventEmitter(),
    onCreated: createEventEmitter(),
    onDetached: createEventEmitter(),
    onMoved: createEventEmitter(),
    onRemoved: createEventEmitter(),
    onUpdated: createEventEmitter(),
  },
  tabGroups: {
    query: async () => [],
    update: async () => {},
    get: async () => null,
    onCreated: createEventEmitter(),
    onRemoved: createEventEmitter(),
    onUpdated: createEventEmitter(),
  },
};

require('./chrome-tab-groups-sync.js');

const {
  loadChromeTabGroupsSetting,
  saveChromeTabGroupsSetting,
  syncChromeTabGroups,
  collapseChromeTabGroupsInWindow,
  syncChromeTabGroupExpansionForTab,
  resetChromeGroupState,
  isChromeTabGroupsEnabled,
  getChromeGroupCount,
  getManagedChromeGroupIds,
  queryUserChromeGroups,
  getChromeGroupsLastError,
  populateChromeGroupMap,
  queryExistingChromeGroups,
  setImportMode,
  subscribeToChromeTabGroupChanges,
  loadPersistedChromeGroupMap,
  persistChromeGroupMap,
  reorderGroupedTabs,
  assignGroupColor,
  getGroupTitle,
  isGroupIdentityFree,
  pickUncollidingGroupColor,
  SESSION_MAP_KEY,
} = globalThis.TabOutChromeTabGroups;

// Stub chrome.tabGroups.query with REAL semantics: when queryInfo.windowId is
// given, only groups of that window are returned (the implementation relies on
// this filtering after the windowId-parameter migration).
function stubTabGroupsQuery(groups) {
  globalThis.chrome.tabGroups.query = async (opts) => {
    let all = typeof groups === 'function' ? groups() : groups;
    if (opts && opts.windowId != null) {
      all = all.filter(g => Number(g.windowId) === Number(opts.windowId));
    }
    return all;
  };
}

test('assignGroupColor returns blue for session groups', () => {
  assert.equal(assignGroupColor('__session_group__:g1', 0), 'blue');
  assert.equal(assignGroupColor('__session_group__:g2', 5), 'blue');
});

test('assignGroupColor returns yellow for landing pages', () => {
  assert.equal(assignGroupColor('__landing-pages__', 0), 'yellow');
  assert.equal(assignGroupColor('__landing-pages__', 3), 'yellow');
});

test('assignGroupColor cycles through colors for domain groups', () => {
  const colors = ['grey', 'red', 'green', 'pink', 'purple', 'cyan', 'orange'];
  colors.forEach((expected, i) => {
    assert.equal(assignGroupColor('example.com', i), expected);
  });
  // Cycles back
  assert.equal(assignGroupColor('test.com', 7), colors[0]);
});

test('getGroupTitle returns friendly domain for regular groups', () => {
  const group = { domain: 'github.com', tabs: [] };
  const title = getGroupTitle(group);
  assert.equal(typeof title, 'string');
  assert.ok(title.length > 0);
});

test('getGroupTitle uses label for custom groups', () => {
  const group = { domain: 'custom-key', label: 'Work', tabs: [] };
  assert.equal(getGroupTitle(group), 'Work');
});

test('getGroupTitle returns Homepages for landing pages', () => {
  const group = { domain: '__landing-pages__', tabs: [] };
  assert.equal(getGroupTitle(group), 'Homepages');
});

test('loadChromeTabGroupsSetting returns false by default', async () => {
  resetChromeGroupState();
  delete mockStorage.chromeTabGroupsEnabled;
  const result = await loadChromeTabGroupsSetting();
  assert.equal(result, false);
  assert.equal(isChromeTabGroupsEnabled(), false);
});

test('saveChromeTabGroupsSetting persists and updates cached state', async () => {
  resetChromeGroupState();
  const saved = await saveChromeTabGroupsSetting(true);
  assert.equal(saved, true);
  assert.equal(isChromeTabGroupsEnabled(), true);
  assert.equal(mockStorage.chromeTabGroupsEnabled, true);

  const loaded = await loadChromeTabGroupsSetting();
  assert.equal(loaded, true);
});

test('saveChromeTabGroupsSetting toggles off correctly', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);
  assert.equal(isChromeTabGroupsEnabled(), true);
  await saveChromeTabGroupsSetting(false);
  assert.equal(isChromeTabGroupsEnabled(), false);
  assert.equal(mockStorage.chromeTabGroupsEnabled, false);
});

test('syncChromeTabGroups removes groups when disabled', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(false);

  const groups = [
    { domain: 'github.com', tabs: [{ id: 1, windowId: 1, url: 'https://github.com' }] },
  ];

  // Should not throw when disabled
  await syncChromeTabGroups(groups);
  assert.equal(getChromeGroupCount(), 0);
});

test('syncChromeTabGroups creates groups when enabled', async () => {
  resetChromeGroupState();
  let groupCallCount = 0;
  let updateCallArgs = [];

  globalThis.chrome.tabs.group = async (opts) => {
    groupCallCount++;
    return 100 + groupCallCount;
  };

  globalThis.chrome.tabGroups.update = async (id, opts) => {
    updateCallArgs.push({ id, ...opts });
  };

  globalThis.chrome.tabGroups.query = async () => [];
  globalThis.chrome.tabs.query = async (opts) => [];

  await saveChromeTabGroupsSetting(true);

  const groups = [
    { domain: 'github.com', tabs: [{ id: 1, windowId: 1, url: 'https://github.com' }] },
    { domain: 'example.com', tabs: [{ id: 2, windowId: 1, url: 'https://example.com' }] },
  ];

  await syncChromeTabGroups(groups);

  assert.equal(groupCallCount, 2);
  assert.equal(updateCallArgs.length, 2);
  assert.equal(updateCallArgs[0].collapsed, true);
  assert.equal(updateCallArgs[1].collapsed, true);
  // Mirrors rotate through the palette (grey, then red) — the order is part
  // of the title+color fingerprint, so it is asserted as a behavior anchor.
  assert.equal(updateCallArgs[0].color, 'grey');
  assert.equal(updateCallArgs[1].color, 'red');
  // getChromeGroupCount counts distinct group keys, not per-window mappings.
  assert.equal(getChromeGroupCount(), 2);
});

test('syncChromeTabGroups handles tabs in different windows', async () => {
  resetChromeGroupState();
  let groupCallCount = 0;

  globalThis.chrome.tabs.group = async (opts) => {
    groupCallCount++;
    return 200 + groupCallCount;
  };

  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [];
  globalThis.chrome.tabs.query = async (opts) => [];

  await saveChromeTabGroupsSetting(true);

  const groups = [
    {
      domain: 'github.com',
      tabs: [
        { id: 1, windowId: 1, url: 'https://github.com' },
        { id: 3, windowId: 2, url: 'https://github.com/other' },
      ],
    },
  ];

  await syncChromeTabGroups(groups);

  // Should create 1 group for each window → 2 total chrome.tabs.group calls
  assert.equal(groupCallCount, 2);
});

test('syncChromeTabGroups skips unmanaged user-group tabs but keeps managed mirror tabs', async () => {
  resetChromeGroupState();
  const groupCalls = [];

  globalThis.chrome.tabs.group = async (opts) => {
    groupCalls.push(opts);
    return 900 + groupCalls.length;
  };
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [{ id: 101, windowId: 1, title: 'GitHub', color: 'grey' }];
  globalThis.chrome.tabs.query = async (opts) => [];

  await saveChromeTabGroupsSetting(true);
  await populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 101 },
  ]);

  const groups = [
    {
      domain: 'github.com',
      tabs: [
        // Managed mirror tab: must still be included in the mirror sync.
        { id: 1, windowId: 1, url: 'https://github.com', groupId: 101 },
        // Unmanaged user-created group tab: must never be pulled into the mirror.
        { id: 2, windowId: 1, url: 'https://github.com/2', groupId: 202 },
      ],
    },
  ];

  await syncChromeTabGroups(groups);

  assert.equal(groupCalls.length, 1);
  assert.deepEqual(groupCalls[0].tabIds, [1]);
});

test('syncChromeTabGroups reorders tabs inside a chrome group to match desired order', async () => {
  resetChromeGroupState();
  const moveCalls = [];

  globalThis.chrome.tabs.group = async () => 901;
  globalThis.chrome.tabs.move = async (tabId, opts) => {
    moveCalls.push({ tabId, ...opts });
  };
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [];
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 901) {
      return [
        { id: 2, groupId: 901, windowId: 1, index: 7 },
        { id: 1, groupId: 901, windowId: 1, index: 8 },
      ];
    }
    return [];
  };

  await saveChromeTabGroupsSetting(true);

  await syncChromeTabGroups([
    {
      domain: 'github.com',
      tabs: [
        { id: 1, windowId: 1, url: 'https://github.com/1' },
        { id: 2, windowId: 1, url: 'https://github.com/2' },
      ],
    },
  ]);

  assert.deepEqual(moveCalls, [
    { tabId: 1, windowId: 1, index: 7 },
    { tabId: 2, windowId: 1, index: 8 },
  ]);
});

test('reorderGroupedTabs prefers the live group window over a stale caller windowId (C5)', async () => {
  resetChromeGroupState();
  const moveCalls = [];
  globalThis.chrome.tabs.move = async (tabId, opts) => {
    moveCalls.push({ tabId, ...opts });
  };
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 901) {
      return [
        { id: 2, groupId: 901, windowId: 7, index: 3 },
        { id: 1, groupId: 901, windowId: 7, index: 4 },
      ];
    }
    return [];
  };

  // Caller passes a WRONG windowId (stale snapshot/placeholder); the reorder
  // must use the window the tabs actually live in (7), not the caller's 1.
  await reorderGroupedTabs(901, [1, 2], 1);

  assert.deepEqual(moveCalls, [
    { tabId: 1, windowId: 7, index: 3 },
    { tabId: 2, windowId: 7, index: 4 },
  ]);
});

test('reorderGroupedTabs applies a full desired order at the group start (mid-card drop)', async () => {
  resetChromeGroupState();
  const moveCalls = [];
  globalThis.chrome.tabs.move = async (tabId, opts) => {
    moveCalls.push({ tabId, ...opts });
  };
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 901) {
      // Existing tabs at 0/1; the dropped batch was appended at 4 by
      // chrome.tabs.group. The caller passes the FULL panel order.
      return [
        { id: 1, groupId: 901, windowId: 7, index: 0 },
        { id: 2, groupId: 901, windowId: 7, index: 1 },
        { id: 3, groupId: 901, windowId: 7, index: 4 },
      ];
    }
    return [];
  };

  await reorderGroupedTabs(901, [3, 1, 2], 999);

  assert.deepEqual(moveCalls, [
    { tabId: 3, windowId: 7, index: 0 },
    { tabId: 1, windowId: 7, index: 1 },
    { tabId: 2, windowId: 7, index: 2 },
  ]);
});

test('reorderGroupedTabs only moves tabs that are actually in the group (C15 superset)', async () => {
  resetChromeGroupState();
  const moveCalls = [];
  globalThis.chrome.tabs.move = async (tabId, opts) => {
    moveCalls.push({ tabId, ...opts });
  };
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 901) {
      return [
        { id: 1, groupId: 901, windowId: 7, index: 0 },
        { id: 2, groupId: 901, windowId: 7, index: 1 },
      ];
    }
    return [];
  };

  // desired includes id 3, which is NOT in the group (a caller may pass a
  // superset after a partial failure). Only ids actually in the group may be
  // moved — dragging an absent id would pull an ungrouped tab into the strip.
  await reorderGroupedTabs(901, ['2', '1', '3'], 7);

  assert.deepEqual(moveCalls, [
    { tabId: 2, windowId: 7, index: 0 },
    { tabId: 1, windowId: 7, index: 1 },
  ]);
});

test('loadPersistedChromeGroupMap keeps an exact session mapping despite a title-and-color collision (C4)', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);
  // The mirror mapping established this session points at 901 — the non-first
  // candidate. The exact session id must keep it separate from user group 900.
  await populateChromeGroupMap([{ virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 901 }]);
  // Seed persisted meta as if an earlier sync stored the mirror fingerprint.
  await chrome.storage.local.set({
    chromeTabGroupsMeta: { 'github.com': { '1': { title: 'Github', color: 'grey' } } },
  });
  // Two groups share the fingerprint: 900 (user's group) and 901 (our mirror).
  globalThis.chrome.tabGroups.query = async () => [
    { id: 900, windowId: 1, title: 'Github', color: 'grey' },
    { id: 901, windowId: 1, title: 'Github', color: 'grey' },
  ];

  await loadPersistedChromeGroupMap();

  const managed = getManagedChromeGroupIds();
  assert.ok(managed.has(901), 'the current mirror mapping is kept (not the first-match guess)');
  assert.ok(!managed.has(900), 'the user group is not hijacked');
  delete globalThis.chrome.tabGroups.query;
});

test('syncChromeTabGroups avoids a colliding title+color when creating a new mirror (C4)', async () => {
  resetChromeGroupState();
  const updates = [];
  globalThis.friendlyDomain = () => 'Github';
  globalThis.chrome.tabs.group = async (opts) => opts.groupId ?? 902;
  globalThis.chrome.tabs.query = async (opts) => opts?.groupId === 902 ? [] : [];
  // A user-created group already holds the mirror's would-be fingerprint.
  globalThis.chrome.tabGroups.query = async () => [
    { id: 101, windowId: 1, title: 'Github', color: 'grey' },
  ];
  globalThis.chrome.tabGroups.update = async (groupId, props) => updates.push({ groupId, props });

  await saveChromeTabGroupsSetting(true);
  const groups = [{
    domain: 'github.com',
    tabs: [{ id: 1, windowId: 1, url: 'https://github.com', groupId: -1 }],
  }];
  await syncChromeTabGroups(groups);

  // The new mirror must not reuse the colliding grey identity, otherwise the
  // title+color fingerprint stays ambiguous and churns on every load.
  const mirrorUpdate = updates.find(u => u.groupId === 902);
  assert.ok(mirrorUpdate, 'a new mirror group was created');
  assert.notEqual(mirrorUpdate.props.color, 'grey');
  delete globalThis.friendlyDomain;
  delete globalThis.chrome.tabs.group;
  delete globalThis.chrome.tabs.query;
  delete globalThis.chrome.tabGroups.query;
  delete globalThis.chrome.tabGroups.update;
});

test('isGroupIdentityFree detects title+color collisions per window (C4)', () => {
  const groups = [
    { id: 1, windowId: 5, title: 'GitHub', color: 'grey' },
    { id: 2, windowId: 5, title: 'GitHub', color: 'red' },
    { id: 3, windowId: 6, title: 'GitHub', color: 'grey' },
  ];
  // Same window + same title+color → not free.
  assert.equal(isGroupIdentityFree('GitHub', 'grey', 5, groups), false);
  // Same window but different color → free.
  assert.equal(isGroupIdentityFree('GitHub', 'blue', 5, groups), true);
  // Same title+color in a window that itself holds such a group → not free.
  assert.equal(isGroupIdentityFree('GitHub', 'grey', 6, groups), false);
  // Same title+color in a window with no such group → free.
  assert.equal(isGroupIdentityFree('GitHub', 'grey', 7, groups), true);
  // No live groups → free.
  assert.equal(isGroupIdentityFree('X', 'grey', 1, []), true);
  assert.equal(isGroupIdentityFree('X', 'grey', 1, null), true);
});

test('pickUncollidingGroupColor returns the preferred color when free, else rotates (C4)', () => {
  const colliding = (color) => [{ id: 1, windowId: 5, title: 'GitHub', color }];
  // Preferred grey is free → stays grey.
  assert.equal(pickUncollidingGroupColor('GitHub', 'grey', 5, colliding('red')), 'grey');
  // Grey is taken → the first free palette color (red) is chosen.
  assert.equal(pickUncollidingGroupColor('GitHub', 'grey', 5, colliding('grey')), 'red');
  // Every palette color is taken → falls back to the preferred color.
  const allTaken = ['grey', 'red', 'green', 'pink', 'purple', 'cyan', 'orange']
    .map((color, i) => ({ id: i + 1, windowId: 5, title: 'GitHub', color }));
  assert.equal(pickUncollidingGroupColor('GitHub', 'grey', 5, allTaken), 'grey');
});

test('legacy local metadata cannot change an exact in-session mapping (C4)', async () => {
  resetChromeGroupState();
  // A session mapping in window 1; a flat snapshot from the old local cache
  // must be ignored and deleted rather than participating in reconciliation.
  await populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 501 },
  ]);
  await chrome.storage.local.set({
    chromeTabGroupsMeta: { 'github.com': { title: 'Github', color: 'grey' } },
  });
  // Two windows share the old fingerprint; only the exact session mapping is
  // eligible for management.
  globalThis.chrome.tabGroups.query = async () => [
    { id: 501, windowId: 1, title: 'Github', color: 'grey' },
    { id: 502, windowId: 2, title: 'Github', color: 'grey' },
  ];

  await loadPersistedChromeGroupMap();

  const managed = getManagedChromeGroupIds();
  assert.ok(managed.has(501), 'the in-session mapping is kept');
  assert.ok(!managed.has(502), 'the other window group is not hijacked');
  assert.equal(mockStorage.chromeTabGroupsMeta, undefined, 'the obsolete local cache is removed');
  delete globalThis.chrome.tabGroups.query;
});

test('syncChromeTabGroups no longer reorders the window tab strip (card order follows Chrome)', async () => {
  resetChromeGroupState();
  const moveCalls = [];

  globalThis.chrome.tabs.group = async (opts) => opts.groupId ?? 0;
  globalThis.chrome.tabs.move = async (tabId, opts) => {
    moveCalls.push({ tabId, ...opts });
  };
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [
    { id: 501, title: 'GitHub', color: 'grey', windowId: 1 },
    { id: 502, title: 'Bilibili', color: 'red', windowId: 1 },
  ];
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 501) {
      return [{ id: 11, groupId: 501, windowId: 1, index: 8 }];
    }
    if (opts?.groupId === 502) {
      return [{ id: 22, groupId: 502, windowId: 1, index: 5 }];
    }
    if (opts?.windowId === 1) {
      return [
        { id: 22, windowId: 1, index: 5 },
        { id: 11, windowId: 1, index: 8 },
      ];
    }
    return [];
  };

  await saveChromeTabGroupsSetting(true);
  await populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 501 },
    { virtualGroupKey: 'bilibili.com', windowId: 1, chromeGroupId: 502 },
  ]);

  await syncChromeTabGroups([
    { domain: 'github.com', tabs: [{ id: 11, windowId: 1, url: 'https://github.com' }] },
    { domain: 'bilibili.com', tabs: [{ id: 22, windowId: 1, url: 'https://bilibili.com' }] },
  ]);

  // Decision: card order follows Chrome's group strip order — the dashboard
  // never forces a window-wide tab reorder anymore.
  assert.equal(moveCalls.length, 0);
});

test('syncChromeTabGroups cleans up when disabled after being enabled', async () => {
  resetChromeGroupState();
  let ungroupCalls = [];

  globalThis.chrome.tabs.ungroup = async (tabIds) => {
    ungroupCalls.push(tabIds);
  };

  globalThis.chrome.tabs.group = async (opts) => 300;
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [];
  globalThis.chrome.tabs.query = async (opts) => [];

  await saveChromeTabGroupsSetting(true);

  const groups = [
    { domain: 'test.com', tabs: [{ id: 10, windowId: 1, url: 'https://test.com' }] },
  ];

  await syncChromeTabGroups(groups);
  assert.ok(getChromeGroupCount() > 0);

  // Now disable
  await saveChromeTabGroupsSetting(false);
  await syncChromeTabGroups(groups);

  assert.equal(getChromeGroupCount(), 0);
});

test('syncChromeTabGroups handles empty tabs gracefully', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);
  await syncChromeTabGroups([]);
  assert.equal(getChromeGroupCount(), 0);
});

test('syncChromeTabGroups handles groups with no tabs', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);
  await syncChromeTabGroups([{ domain: 'empty.com', tabs: [] }]);
  assert.equal(getChromeGroupCount(), 0);
});

test('populateChromeGroupMap adds mappings to internal state', () => {
  resetChromeGroupState();
  populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 101 },
    { virtualGroupKey: 'github.com', windowId: 2, chromeGroupId: 102 },
  ]);
  assert.equal(getChromeGroupCount(), 1);
});

test('queryExistingChromeGroups returns groups from chrome.tabGroups.query', async () => {
  globalThis.chrome.tabGroups.query = async () => [
    { id: 1, title: 'Work', color: 'blue' },
    { id: 2, title: 'Research', color: 'red' },
  ];
  const groups = await queryExistingChromeGroups();
  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, 'Work');
});

test('getManagedChromeGroupIds reports only dashboard-managed mirror groups', async () => {
  resetChromeGroupState();
  populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 101 },
  ]);
  const managed = getManagedChromeGroupIds();
  assert.ok(managed.has(101));
  assert.ok(!managed.has(999));
});

test('queryUserChromeGroups returns unmanaged groups with strip positions, sorted', async () => {
  resetChromeGroupState();
  // 101 is dashboard-managed; 202 and 303 were created by the user in Chrome.
  populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 101 },
  ]);
  stubTabGroupsQuery([
    { id: 101, title: 'GitHub', color: 'grey', windowId: 1 },
    { id: 202, title: 'Work', color: 'blue', windowId: 1 },
    { id: 303, title: 'Research', color: 'red', windowId: 1 },
    { id: 404, title: 'Other window', color: 'green', windowId: 2 },
  ]);
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 101) return [{ id: 10, index: 0 }];
    if (opts?.groupId === 202) return [{ id: 21, index: 4 }, { id: 22, index: 5 }];
    if (opts?.groupId === 303) return [{ id: 31, index: 2 }];
    if (opts?.groupId === 404) return [{ id: 41, index: 0 }];
    return [];
  };

  const groups = await queryUserChromeGroups(1);
  // Managed group 101 and other-window group 404 are excluded; order by minIndex.
  assert.deepEqual(groups.map(g => g.id), [303, 202]);
  assert.equal(groups[0].title, 'Research');
  assert.equal(groups[1].minIndex, 4);
  assert.deepEqual(groups[1].tabIds, [21, 22]);
});

test('queryUserChromeGroups records failures so the dashboard can distinguish empty from error', async () => {
  resetChromeGroupState();

  globalThis.chrome.tabGroups.query = async () => { throw new Error('denied'); };
  const groups = await queryUserChromeGroups(1);
  assert.deepEqual(groups, []);
  assert.ok(getChromeGroupsLastError().length > 0);

  globalThis.chrome.tabGroups.query = async () => [];
  await queryUserChromeGroups(1);
  assert.equal(getChromeGroupsLastError(), '');
});

test('queryUserChromeGroups keeps other groups when one group query partially fails (C6)', async () => {
  resetChromeGroupState();
  // 202's tab query rejects transiently; 303 succeeds. The partial failure
  // must not drag the whole result down to "no groups", nor be cleared like a
  // clean success — the diagnostic stays so the dashboard can tell part-failed
  // from "really no groups".
  stubTabGroupsQuery([
    { id: 202, title: 'Work', color: 'blue', windowId: 1 },
    { id: 303, title: 'Research', color: 'red', windowId: 1 },
  ]);
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 202) throw new Error('transient query failure');
    if (opts?.groupId === 303) return [{ id: 31, index: 2 }];
    return [];
  };

  const groups = await queryUserChromeGroups(1);
  // The healthy group survives in the result.
  assert.deepEqual(groups.map(g => g.id), [303]);
  // The partial failure is NOT cleared like a clean success.
  assert.ok(getChromeGroupsLastError().length > 0);
  delete globalThis.chrome.tabGroups.query;
  delete globalThis.chrome.tabs.query;
});

test('syncChromeTabGroups reuses chromeGroupMap populated by populateChromeGroupMap', async () => {
  resetChromeGroupState();
  let lastGroupCall = null;

  globalThis.chrome.tabs.group = async (opts) => {
    lastGroupCall = opts;
    return 500;
  };
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [{ id: 500, windowId: 1, title: 'GitHub', color: 'grey' }];
  globalThis.chrome.tabs.query = async (opts) => [];

  await saveChromeTabGroupsSetting(true);

  // Pre-populate the mapping (simulating "pull from Chrome groups" scenario)
  await populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 500 },
  ]);

  const groups = [
    { domain: 'github.com', tabs: [{ id: 10, windowId: 1, url: 'https://github.com' }] },
  ];

  await syncChromeTabGroups(groups);

  // Should have reused the existing group — called with groupId (reuse path), not tabIds (create path)
  assert.equal(lastGroupCall.groupId, 500);
  assert.deepEqual(lastGroupCall.tabIds, [10]);
});

test('syncChromeTabGroups only removes obsolete mappings in synced windows', async () => {
  resetChromeGroupState();
  const ungroupedTabIds = [];

  globalThis.chrome.tabs.group = async (opts) => opts.groupId ?? 700;
  globalThis.chrome.tabs.ungroup = async (tabIds) => {
    ungroupedTabIds.push(...tabIds);
  };
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [
    { id: 501, title: 'GitHub', color: 'grey', windowId: 1 },
    { id: 502, title: 'GitHub', color: 'grey', windowId: 2 },
    { id: 503, title: 'Docs', color: 'blue', windowId: 2 },
  ];
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 502) return [{ id: 202, windowId: 2 }];
    if (opts?.groupId === 503) return [{ id: 203, windowId: 2 }];
    return [];
  };

  await saveChromeTabGroupsSetting(true);
  populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 501 },
    { virtualGroupKey: 'github.com', windowId: 2, chromeGroupId: 502 },
    { virtualGroupKey: 'docs.example', windowId: 2, chromeGroupId: 503 },
  ]);

  await syncChromeTabGroups([
    { domain: 'github.com', tabs: [{ id: 101, windowId: 1, url: 'https://github.com' }] },
  ]);

  assert.deepEqual(ungroupedTabIds, []);
  assert.equal(getChromeGroupCount(), 2);
});

test('syncChromeTabGroups skips manual groups; stale manual mirrors are cleaned up', async () => {
  resetChromeGroupState();
  let createCalls = 0;
  let reuseCalls = 0;

  globalThis.chrome.tabs.group = async (opts) => {
    if (opts.groupId != null) {
      reuseCalls++;
      return opts.groupId;
    }
    createCalls++;
    return 600 + createCalls;
  };
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [{ id: 500, title: 'Work', color: 'blue' }];
  globalThis.chrome.tabs.query = async (opts) => [];

  await saveChromeTabGroupsSetting(true);

  // A legacy managed mapping for a manual group: it must NOT be reused — manual
  // groups are dashboard-internal and never create Chrome groups anymore.
  populateChromeGroupMap([
    { virtualGroupKey: '__session_group__:g1', windowId: 1, chromeGroupId: 500 },
  ]);

  const groups = [
    { domain: '__session_group__:g1', isManual: true, label: 'Work', tabs: [{ id: 1, windowId: 1, url: 'https://a.com' }] },
    // The flag branch is what actually keeps this group internal: its domain
    // does NOT carry the __session_group__: prefix, so removing the
    // isManual/isChromeGroup guard would wrongly push it to Chrome.
    { domain: 'work-manual', isManual: true, label: 'Manual', tabs: [{ id: 2, windowId: 1, url: 'https://b.com' }] },
    { domain: 'github.com', tabs: [{ id: 5, windowId: 1, url: 'https://github.com' }] },
  ];

  await syncChromeTabGroups(groups);

  // The manual groups were skipped entirely — no reuse of the old Chrome group.
  assert.equal(reuseCalls, 0);
  // Domain cards still get their mirror groups (one create for github.com).
  assert.equal(createCalls, 1);
});

test('stale manual-group mirror is ungrouped when its window appears in the sync', async () => {
  resetChromeGroupState();
  const ungrouped = [];
  let createCalls = 0;

  globalThis.chrome.tabs.group = async (opts) => {
    if (opts.groupId != null) return opts.groupId;
    createCalls++;
    return 600 + createCalls;
  };
  globalThis.chrome.tabs.ungroup = async (tabIds) => ungrouped.push(...tabIds);
  globalThis.chrome.tabGroups.update = async () => {};
  globalThis.chrome.tabGroups.query = async () => [{ id: 500, title: 'Work', color: 'blue', windowId: 2 }];
  globalThis.chrome.tabs.query = async (opts) => {
    if (opts?.groupId === 500) return [{ id: 1, windowId: 2 }];
    return [];
  };

  await saveChromeTabGroupsSetting(true);

  // Legacy mapping for a manual group that is no longer pushed. The manual
  // group's tabs live in window 2 while the only domain mirror in this sync is
  // in window 1 — so the cleanup loop that adds manual/Chrome-card windows to
  // desiredWindowIds is the only thing that can reach the stale mirror (C9).
  populateChromeGroupMap([
    { virtualGroupKey: '__session_group__:g1', windowId: 2, chromeGroupId: 500 },
  ]);

  await syncChromeTabGroups([
    { domain: '__session_group__:g1', label: 'Work', tabs: [{ id: 1, windowId: 2, url: 'https://a.com' }] },
    { domain: 'github.com', tabs: [{ id: 5, windowId: 1, url: 'https://github.com' }] },
  ]);

  assert.deepEqual(ungrouped, [1]);
  assert.equal(getChromeGroupCount(), 1); // only the github.com mirror remains
});

test('session group map reloads an exact live mapping without claiming a same-title user group in another window', async () => {
  await resetChromeGroupState();

  // Mirror for github.com lives in window 1; a USER group with identical
  // title+color exists in window 2. Reload must only re-bind the window-1
  // group, never the user's window-2 group (C10).
  globalThis.chrome.tabGroups.query = async () => [
    // User group first on purpose: if the implementation ignored the window
    // id and just took the first title+color match, it would bind 502 instead
    // of the real mirror 501 (C10).
    { id: 502, title: 'GitHub', color: 'grey', windowId: 2 },
    { id: 501, title: 'GitHub', color: 'grey', windowId: 1 },
  ];
  globalThis.chrome.tabGroups.get = async (id) => ({
    id,
    title: id === 501 ? 'GitHub' : 'GitHub',
    color: id === 501 ? 'grey' : 'grey',
  });

  await chrome.storage.session.set({
    [SESSION_MAP_KEY]: { 'github.com': { '1': 501 } },
  });
  await loadPersistedChromeGroupMap();

  const managed = getManagedChromeGroupIds();
  assert.ok(managed.has(501));
  assert.ok(!managed.has(502));
});

test('browser restart never claims a title-and-color match from obsolete local metadata', async () => {
  await resetChromeGroupState();

  // Window and tab-group ids changed after browser restart. The old local
  // record is deliberately ignored, even though its title/color match the
  // live native group: taking it over would corrupt user-group ownership.
  globalThis.chrome.tabGroups.query = async () => [
    { id: 701, title: 'GitHub', color: 'grey', windowId: 17 },
  ];
  await chrome.storage.local.set({
    chromeTabGroupsMeta: { 'github.com': { '1': { title: 'GitHub', color: 'grey' } } },
  });

  await loadPersistedChromeGroupMap();

  assert.equal(getManagedChromeGroupIds().size, 0);
  assert.equal(mockStorage.chromeTabGroupsMeta, undefined);
});

test('subscribeToChromeTabGroupChanges notifies on external Chrome group changes', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);

  const events = [];
  const unsubscribe = subscribeToChromeTabGroupChanges(event => {
    events.push(event);
  });

  globalThis.chrome.tabGroups.onUpdated.emit({ id: 501, title: 'Work', color: 'grey', windowId: 1, collapsed: false });

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'tabGroups.onUpdated');
  assert.equal(events[0].group.id, 501);

  unsubscribe();
});

test('subscribeToChromeTabGroupChanges notifies with the single-arg TabGroup payload', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);

  const events = [];
  const unsubscribe = subscribeToChromeTabGroupChanges(event => {
    events.push(event);
  });

  // Chrome calls the onUpdated callback with the full updated group object —
  // there is no separate changeInfo argument. Collapse-only updates therefore
  // still notify; the dashboard debounces the resulting re-render.
  globalThis.chrome.tabGroups.onUpdated.emit({ id: 501, title: 'Work', color: 'grey', windowId: 1, collapsed: true });

  assert.equal(events.length, 1);
  assert.equal(events[0].group.collapsed, true);

  unsubscribe();
});

test('subscribeToChromeTabGroupChanges notifies when a grouped tab is moved', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);

  const events = [];
  globalThis.chrome.tabs.get = async (tabId) => ({
    id: tabId,
    groupId: 501,
    windowId: 1,
  });

  const unsubscribe = subscribeToChromeTabGroupChanges(event => {
    events.push(event);
  });

  globalThis.chrome.tabs.onMoved.emit(42, { windowId: 1, fromIndex: 3, toIndex: 6 });

  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'tabs.onMoved');
  assert.equal(events[0].tabId, 42);
  assert.equal(events[0].tab.groupId, 501);

  unsubscribe();
});

test('syncChromeTabGroupExpansionForTab expands target group and collapses sibling groups in same window', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);
  // 101 and 102 are dashboard-managed mirrors; 103 is a user group in another
  // window and must be left alone.
  populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 101 },
    { virtualGroupKey: 'example.com', windowId: 1, chromeGroupId: 102 },
  ]);

  const updateCalls = [];
  stubTabGroupsQuery([
    { id: 101, windowId: 1, collapsed: true },
    { id: 102, windowId: 1, collapsed: false },
    { id: 103, windowId: 2, collapsed: false },
  ]);
  globalThis.chrome.tabGroups.update = async (id, opts) => {
    updateCalls.push({ id, ...opts });
  };

  await syncChromeTabGroupExpansionForTab({ groupId: 101, windowId: 1 });

  assert.deepEqual(updateCalls, [
    { id: 101, collapsed: false },
    { id: 102, collapsed: true },
  ]);
});

test('syncChromeTabGroupExpansionForTab leaves user-created groups untouched', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);

  // 102 is a dashboard-managed mirror in the same window. The guard must stop
  // before touching ANY group when the focused group is the user group 101;
  // without the guard, 102 would be collapsed below.
  populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 102 },
  ]);

  const updateCalls = [];
  stubTabGroupsQuery([
    { id: 101, windowId: 1, collapsed: false },
    { id: 102, windowId: 1, collapsed: false },
  ]);
  globalThis.chrome.tabGroups.update = async (id, opts) => {
    updateCalls.push({ id, ...opts });
  };

  // 101 is a USER group (not in chromeGroupMap): focusing a tab inside it must
  // not expand/collapse anything, managed or not.
  await syncChromeTabGroupExpansionForTab({ groupId: 101, windowId: 1 });

  assert.deepEqual(updateCalls, []);
});

test('syncChromeTabGroupExpansionForTab skips work when Chrome sync is disabled', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(false);

  let queryCount = 0;
  stubTabGroupsQuery(() => {
    queryCount++;
    return [];
  });

  await syncChromeTabGroupExpansionForTab({ groupId: 101, windowId: 1 });

  assert.equal(queryCount, 0);
});

test('collapseChromeTabGroupsInWindow collapses only dashboard-managed groups in the target window', async () => {
  resetChromeGroupState();
  await saveChromeTabGroupsSetting(true);
  // 101 is a dashboard mirror; 102 and 103 are user groups (unmanaged) and
  // must keep their collapsed state no matter the focus event.
  populateChromeGroupMap([
    { virtualGroupKey: 'github.com', windowId: 1, chromeGroupId: 101 },
  ]);

  const updateCalls = [];
  stubTabGroupsQuery([
    { id: 101, windowId: 1, collapsed: false },
    // User group in the same window and expanded: removing the managed filter
    // would collapse it too, so this mock is what makes the guard visible.
    { id: 102, windowId: 1, collapsed: false },
    { id: 103, windowId: 2, collapsed: false },
  ]);
  globalThis.chrome.tabGroups.update = async (id, opts) => {
    updateCalls.push({ id, ...opts });
  };

  await collapseChromeTabGroupsInWindow(1);

  assert.deepEqual(updateCalls, [
    { id: 101, collapsed: true },
  ]);
});
