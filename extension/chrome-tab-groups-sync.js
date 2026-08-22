'use strict';

(function attachChromeTabGroups(globalScope) {

  const STORAGE_KEY = 'chromeTabGroupsEnabled';
  const META_PERSIST_KEY = 'chromeTabGroupsMeta';

  let cachedEnabled = false;
  let chromeGroupMap = {};
  let importMode = false;
  let chromeEventMuteUntil = 0;
  let chromeListenersAttached = false;
  let chromeGroupsLastError = '';
  const chromeGroupSubscribers = new Set();

  const GROUP_COLORS = ['grey', 'red', 'green', 'pink', 'purple', 'cyan', 'orange'];

  function muteChromeGroupEvents(durationMs = 250) {
    chromeEventMuteUntil = Math.max(chromeEventMuteUntil, Date.now() + durationMs);
  }

  function shouldIgnoreChromeEvent() {
    // Only the short echo-mute window suppresses notifications. Whether the
    // sync PUSH is enabled is a separate concern — live card recognition
    // listens to Chrome group events even when the push toggle is off.
    return Date.now() < chromeEventMuteUntil;
  }

  function notifyChromeGroupSubscribers(event) {
    if (shouldIgnoreChromeEvent()) return;
    for (const subscriber of chromeGroupSubscribers) {
      try {
        subscriber(event);
      } catch {}
    }
  }

  function attachChromeListeners() {
    if (chromeListenersAttached || typeof chrome === 'undefined') return;

    const eventBindings = [
      [chrome.tabGroups?.onCreated, group => notifyChromeGroupSubscribers({ source: 'tabGroups.onCreated', group })],
      [chrome.tabGroups?.onUpdated, (group) => {
        // Chrome passes the full updated TabGroup object (there is no separate
        // changeInfo parameter). Collapse-only updates also arrive here; the
        // dashboard side debounces the re-render, so a full notify is safe.
        notifyChromeGroupSubscribers({ source: 'tabGroups.onUpdated', group });
      }],
      [chrome.tabGroups?.onRemoved, group => notifyChromeGroupSubscribers({ source: 'tabGroups.onRemoved', group })],
      [chrome.tabs?.onAttached, (tabId, attachInfo) => notifyChromeGroupSubscribers({ source: 'tabs.onAttached', tabId, attachInfo })],
      [chrome.tabs?.onCreated, tab => notifyChromeGroupSubscribers({ source: 'tabs.onCreated', tab })],
      [chrome.tabs?.onDetached, (tabId, detachInfo) => notifyChromeGroupSubscribers({ source: 'tabs.onDetached', tabId, detachInfo })],
      [chrome.tabs?.onMoved, async (tabId, moveInfo) => {
        try {
          const movedTab = await chrome.tabs.get(tabId);
          if (movedTab?.groupId == null || Number(movedTab.groupId) < 0) return;
          notifyChromeGroupSubscribers({ source: 'tabs.onMoved', tabId, moveInfo, tab: movedTab });
        } catch {}
      }],
      [chrome.tabs?.onRemoved, (tabId, removeInfo) => notifyChromeGroupSubscribers({ source: 'tabs.onRemoved', tabId, removeInfo })],
      [chrome.tabs?.onUpdated, (tabId, changeInfo, tab) => {
        if (changeInfo?.groupId == null) return;
        notifyChromeGroupSubscribers({ source: 'tabs.onUpdated', tabId, changeInfo, tab });
      }],
    ];

    for (const [eventSource, listener] of eventBindings) {
      if (eventSource && typeof eventSource.addListener === 'function') {
        eventSource.addListener(listener);
      }
    }

    chromeListenersAttached = true;
  }

  function getGroupTitle(group) {
    if (group.domain === '__landing-pages__') return 'Homepages';
    if (group.label) return group.label;
    try {
      const hostname = group.domain.replace(/^__session_group__:/, '');
      return friendlyDomain(hostname);
    } catch {
      return group.domain;
    }
  }

  // Session groups and the landing-pages card keep dedicated colors (blue /
  // yellow); regular domain mirrors cycle through the shared palette. The
  // assigned color is part of a mirror's title+color identity fingerprint
  // (see loadPersistedChromeGroupMap), so the palette order must stay stable.
  function assignGroupColor(groupKey, index) {
    if (groupKey.startsWith('__session_group__:')) return 'blue';
    if (groupKey === '__landing-pages__') return 'yellow';
    return GROUP_COLORS[index % GROUP_COLORS.length];
  }

  /**
   * currentMappingCandidates(groupKey, windowIdKey, matches)
   *
   * Returns the in-session mappings that are still among the ambiguous
   * candidates (each as { windowId, id }). For per-window meta keys only that
   * window's mapping counts; for legacy flat meta ('any' key) the in-session
   * map is keyed by the real window id, so every window mapping of this group
   * key is considered — the session may legitimately hold mirrors for the same
   * group key in several windows (C4 follow-up).
   */
  function currentMappingCandidates(groupKey, windowIdKey, matches) {
    const windowMap = chromeGroupMap?.[groupKey];
    if (!windowMap) return [];
    if (windowIdKey !== 'any') {
      const currentId = windowMap[windowIdKey];
      const match = currentId != null ? matches.find(g => Number(g.id) === Number(currentId)) : null;
      return match ? [{ windowId: match.windowId, id: match.id }] : [];
    }
    const kept = [];
    for (const [windowIdStr, chromeGroupId] of Object.entries(windowMap)) {
      if (chromeGroupId != null && matches.some(g => Number(g.id) === Number(chromeGroupId))) {
        kept.push({ windowId: windowIdStr, id: chromeGroupId });
      }
    }
    return kept;
  }

  /**
   * isGroupIdentityFree(title, color, windowId, currentGroups)
   *
   * A mirror's identity is its window + title + color fingerprint. Returns
   * true when no group in the given window already carries that fingerprint.
   * Used before creating a new mirror so its identity can never stay
   * ambiguous for loadPersistedChromeGroupMap (C4 follow-up).
   */
  function isGroupIdentityFree(title, color, windowId, currentGroups) {
    if (!Array.isArray(currentGroups)) return true;
    return !currentGroups.some(g =>
      Number(g.windowId) === Number(windowId) &&
      g.title === title &&
      g.color === color
    );
  }

  /**
   * pickUncollidingGroupColor(title, preferred, windowId, currentGroups)
   *
   * Returns the first palette color that keeps the mirror's fingerprint
   * unique in the window; falls back to the preferred color when every
   * palette color collides (extreme case).
   */
  function pickUncollidingGroupColor(title, preferred, windowId, currentGroups) {
    if (!Array.isArray(currentGroups)) return preferred;
    for (const color of GROUP_COLORS) {
      if (isGroupIdentityFree(title, color, windowId, currentGroups)) return color;
    }
    return preferred;
  }

  async function loadChromeTabGroupsSetting() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      cachedEnabled = Boolean(stored[STORAGE_KEY]);
    } catch {
      cachedEnabled = false;
    }
    await loadPersistedChromeGroupMap();
    return cachedEnabled;
  }

  async function saveChromeTabGroupsSetting(enabled) {
    cachedEnabled = Boolean(enabled);
    await chrome.storage.local.set({ [STORAGE_KEY]: cachedEnabled });
    return cachedEnabled;
  }

  async function persistChromeGroupMap() {
    try {
      // Save group metadata (title, color) per window instead of raw groupIds,
      // since Chrome tab group IDs are only stable within a session. Keeping
      // the window id in the key lets reload match within the SAME window, so a
      // user-created group that happens to share title+color in another window
      // is never misclassified as a dashboard mirror.
      const meta = {};
      for (const [groupKey, windowMap] of Object.entries(chromeGroupMap)) {
        for (const [windowIdStr, chromeGroupId] of Object.entries(windowMap)) {
          try {
            const group = await chrome.tabGroups.get(chromeGroupId);
            if (group) {
              if (!meta[groupKey]) meta[groupKey] = {};
              meta[groupKey][windowIdStr] = { title: group.title, color: group.color };
            }
          } catch {}
        }
      }
      await chrome.storage.local.set({ [META_PERSIST_KEY]: meta });
    } catch {}
  }

  async function loadPersistedChromeGroupMap() {
    try {
      const result = await chrome.storage.local.get(META_PERSIST_KEY);
      const meta = result[META_PERSIST_KEY];
      if (!meta || Object.keys(meta).length === 0) return;

      const currentGroups = await chrome.tabGroups.query({});
      const reconciled = {};

      for (const [groupKey, stored] of Object.entries(meta)) {
        // Stored shape is { windowId: { title, color } }. Older snapshots may
        // be flat { title, color } — fall back to matching any window for them.
        const perWindow = stored && typeof stored === 'object' && !('title' in stored) && !('color' in stored)
          ? stored
          : { any: stored };
        for (const [windowIdKey, info] of Object.entries(perWindow)) {
          if (!info || typeof info !== 'object') continue;
          // Match by window + title + color — the values we control. After
          // restart Chrome assigns new groupIds, but our groups retain their
          // title/color within the same window.
          const matches = currentGroups.filter(g =>
            (windowIdKey === 'any' || Number(g.windowId) === Number(windowIdKey)) &&
            g.title === info.title && g.color === info.color
          );
          // If more than one group has the same title+color (legacy flat
          // snapshots across windows, or same-window duplicates after the
          // per-window migration), auto-binding would be a coin toss that can
          // mark a user group as a mirror. Prefer the mapping THIS session
          // already established when it is still among the candidates — that
          // group is the mirror we created/managed, so reusing it is not a
          // guess. Otherwise skip and let the next persist (or a toggle off/on)
          // rebuild a correct mapping (C4).
          if (matches.length > 1) {
            const currentMatches = currentMappingCandidates(groupKey, windowIdKey, matches);
            if (currentMatches.length > 0) {
              for (const cm of currentMatches) {
                if (!reconciled[groupKey]) reconciled[groupKey] = {};
                reconciled[groupKey][cm.windowId] = cm.id;
              }
              continue;
            }
            console.warn(`[tab-harbor] ambiguous chromeTabGroupsMeta for ${groupKey}; skipping auto-bind`);
            continue;
          }
          if (matches.length === 0 && windowIdKey !== 'any') {
            // Restart recovery: Chrome renumbers window ids every browser
            // session, so a per-window record can point at a window id that
            // no longer exists even though the mirror itself survived in its
            // reopened window. Re-bind by title+color across all windows, but
            // only when EXACTLY ONE candidate carries the fingerprint — with
            // several, binding would be a guess that can hijack a user-created
            // group (C4), so leave the mirror unbound instead.
            const candidates = currentGroups.filter(g => g.title === info.title && g.color === info.color);
            if (candidates.length === 1) {
              if (!reconciled[groupKey]) reconciled[groupKey] = {};
              reconciled[groupKey][candidates[0].windowId] = candidates[0].id;
            }
            continue;
          }
          const match = matches[0];
          if (match) {
            if (!reconciled[groupKey]) reconciled[groupKey] = {};
            reconciled[groupKey][match.windowId] = match.id;
          }
        }
      }

      chromeGroupMap = reconciled;
    } catch {}
  }

  function isChromeApiAvailable() {
    const available = typeof chrome !== 'undefined' &&
      chrome.tabs && typeof chrome.tabs.group === 'function' &&
      chrome.tabGroups && typeof chrome.tabGroups.update === 'function';
    if (!available) chromeGroupsLastError = 'chrome.tabGroups API unavailable';
    return available;
  }

  function getChromeGroupsLastError() {
    return chromeGroupsLastError;
  }

  async function ungroupTabs(tabIds) {
    if (!tabIds || tabIds.length === 0) return;
    try {
      await chrome.tabs.ungroup(tabIds);
    } catch {
      // Tab may have been closed already
    }
  }

  async function reorderGroupedTabs(chromeGroupId, desiredTabIds, windowId) {
    if (!chromeGroupId || !Array.isArray(desiredTabIds) || desiredTabIds.length === 0) return;

    // Callers may pass chip tokens (string ids) or raw tab ids — normalize to
    // numbers so the strict comparisons and chrome.tabs.move receive numbers.
    const desiredIds = desiredTabIds
      .map(id => Number(id))
      .filter(Number.isFinite);
    if (desiredIds.length === 0) return;

    const desiredSet = new Set(desiredIds.map(String));

    let groupedTabs = [];
    try {
      groupedTabs = await chrome.tabs.query({ groupId: chromeGroupId });
    } catch {
      return;
    }

    if (!groupedTabs.length) return;

    const currentTabs = groupedTabs
      .filter(tab => desiredSet.has(String(tab.id)))
      .sort((a, b) => a.index - b.index);
    if (!currentTabs.length) return;

    // Only move tabs that are actually in the target group. Callers may pass a
    // superset (e.g. after a partial group failure); moving absent ids would
    // drag ungrouped tabs into the group's strip area (C15).
    const currentSet = new Set(currentTabs.map(tab => String(tab.id)));
    const idsToMove = desiredIds.filter(id => currentSet.has(String(id)));
    if (idsToMove.length <= 1) return;

    const currentOrder = currentTabs.map(tab => tab.id);
    if (idsToMove.length === currentOrder.length &&
        currentOrder.every((tabId, index) => tabId === idsToMove[index])) {
      return;
    }

    const baseIndex = Math.min(...currentTabs.map(tab => tab.index));
    // Prefer the group's own window from the live query: callers pass a
    // windowId that may come from a stale snapshot or a placeholder row. The
    // live query result is authoritative for the group's real window.
    const liveWindowId = currentTabs[0]?.windowId != null ? Number(currentTabs[0].windowId) : NaN;
    const effectiveWindowId = Number.isFinite(liveWindowId) ? liveWindowId : Number(windowId);
    if (!Number.isFinite(effectiveWindowId)) {
      console.warn('[tab-harbor] reorderGroupedTabs: no usable windowId, skipping reorder');
      return;
    }
    for (const [offset, tabId] of idsToMove.entries()) {
      try {
        await chrome.tabs.move(tabId, { windowId: effectiveWindowId, index: baseIndex + offset });
      } catch (err) {
        // Do not swallow silently: a failed move means the panel order and the
        // native group order diverge and the user cannot see why.
        console.warn(`[tab-harbor] reorderGroupedTabs: move tab ${tabId} failed:`, err);
      }
    }
  }

  async function removeAllChromeGroups() {
    muteChromeGroupEvents();
    const allTrackedTabIds = [];
    for (const windowMap of Object.values(chromeGroupMap)) {
      for (const chromeGroupId of Object.values(windowMap)) {
        try {
          const group = await chrome.tabGroups.get(chromeGroupId);
          if (group) {
            const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
            allTrackedTabIds.push(...tabs.map(t => t.id).filter(Boolean));
          }
        } catch {
          // Group may have been removed externally
        }
      }
    }
    if (allTrackedTabIds.length > 0) {
      await ungroupTabs(allTrackedTabIds);
    }
    chromeGroupMap = {};
    await persistChromeGroupMap();
  }

  function getManagedChromeGroupIds() {
    const ids = new Set();
    for (const windowMap of Object.values(chromeGroupMap)) {
      for (const chromeGroupId of Object.values(windowMap)) {
        if (chromeGroupId != null) ids.add(chromeGroupId);
      }
    }
    return ids;
  }

  /**
   * queryUserChromeGroups(windowId)
   *
   * Returns the native Chrome tab groups of the given window that the DASHBOARD
   * does not manage (i.e. groups the user created in the browser, not the
   * mirror groups this extension pushed). Each entry carries the group's live
   * title/color, its tab ids and its strip position (min tab index) so the
   * dashboard can render one card per group, ordered like the tab strip.
   */
  async function queryUserChromeGroups(windowId) {
    if (!isChromeApiAvailable()) return [];
    let hadPartialFailure = false;
    try {
      // Let the API filter by window (windowId is always a real window id from
      // getDashboardWindowIdForOpenTabs); fall back to an unfiltered query only
      // for a defensive non-finite id.
      const groups = Number.isFinite(Number(windowId))
        ? await chrome.tabGroups.query({ windowId: Number(windowId) })
        : await chrome.tabGroups.query({});
      const managed = getManagedChromeGroupIds();
      const result = [];
      for (const group of groups) {
        if (managed.has(group.id)) continue;
        let tabs = [];
        try {
          tabs = await chrome.tabs.query({ groupId: group.id });
        } catch (err) {
          // C6: a single group's tab query failing must not be silently
          // treated as "this group is empty"; keep the diagnostic so the
          // dashboard can distinguish API failure from genuinely no groups.
          hadPartialFailure = true;
          chromeGroupsLastError = err?.message || String(err || 'queryUserChromeGroups tabs.query failed');
          console.warn(`[tab-harbor] queryUserChromeGroups: tabs.query failed for group ${group.id}:`, err);
          continue;
        }
        if (!tabs.length) continue;
        const positions = tabs.map(t => t.index).filter(Number.isFinite);
        result.push({
          id: group.id,
          windowId: Number(group.windowId),
          title: group.title || '',
          color: group.color || 'grey',
          collapsed: Boolean(group.collapsed),
          minIndex: positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER,
          tabIds: tabs.map(t => t.id).filter(id => id != null),
        });
      }
      if (!hadPartialFailure) chromeGroupsLastError = '';
      return result.sort((a, b) => a.minIndex - b.minIndex);
    } catch (err) {
      // Never silently pretend there are no user groups: keep a diagnostic and
      // let the dashboard surface a visible failure state.
      chromeGroupsLastError = err?.message || String(err || 'queryUserChromeGroups failed');
      console.warn('[tab-harbor] queryUserChromeGroups failed:', err);
      return [];
    }
  }

  async function syncChromeTabGroups(domainGroups) {
    muteChromeGroupEvents();
    await loadPersistedChromeGroupMap();

    if (!cachedEnabled) {
      await removeAllChromeGroups();
      return;
    }

    if (!isChromeApiAvailable()) return;

    // Build desired state: { groupKey: { windowId: [tabIds] } }
    const managedGroupIds = getManagedChromeGroupIds();
    const desired = {};
    for (const group of domainGroups) {
      const groupKey = group.domain;
      // Manual groups stay dashboard-internal, and live Chrome-group cards are
      // already native groups — neither is pushed to Chrome.
      if (group.isManual || group.isChromeGroup) continue;
      if (groupKey.startsWith('__session_group__:') || groupKey.startsWith('__chrome_group__:')) continue;
      for (const tab of (group.tabs || [])) {
        if (tab.id == null) continue;
        // C7 safety net: tabs that the live snapshot reports as already inside
        // an UNMANAGED native Chrome group must never be pushed into a
        // dashboard mirror, even if queryUserChromeGroups failed and the card
        // was not built. Tabs inside dashboard-managed mirror groups stay in
        // desired so sync can continue managing those mirrors.
        if (Number.isInteger(tab.groupId) && tab.groupId >= 0 && !managedGroupIds.has(tab.groupId)) continue;
        const windowId = tab.windowId != null ? tab.windowId : 0;
        if (!desired[groupKey]) desired[groupKey] = {};
        if (!desired[groupKey][windowId]) desired[groupKey][windowId] = [];
        desired[groupKey][windowId].push(tab.id);
      }
    }

    // Collect current Chrome tab groups to check existence. Full-window query
    // on purpose: this sync manages mirrors across every window represented in
    // `desired` and also cleans stale mappings in other windows.
    let currentGroups = [];
    try {
      currentGroups = await chrome.tabGroups.query({});
    } catch {}

    const validGroupIds = new Set(currentGroups.map(g => g.id));

    // Remove orphaned Chrome groups only for windows represented in this sync.
    // Other windows may be managed by their own Tab Harbor new-tab page.
    // Include the windows of MANUAL/Chrome-group cards too: their groups are
    // skipped from `desired`, but a stale mirror mapping for those windows must
    // still be cleaned up — otherwise a manual group that once had a mirror
    // would keep its Chrome group forever.
    const desiredWindowIds = new Set(
      Object.values(desired)
        .flatMap(windowMap => Object.keys(windowMap))
        .map(windowId => Number(windowId))
        .filter(Number.isFinite)
    );
    for (const group of domainGroups) {
      for (const tab of (group.tabs || [])) {
        if (tab?.windowId != null) desiredWindowIds.add(Number(tab.windowId));
      }
    }
    for (const [groupKey, windowMap] of Object.entries(chromeGroupMap)) {
      for (const [windowIdStr, chromeGroupId] of Object.entries(windowMap)) {
        const windowId = Number(windowIdStr);
        if (!validGroupIds.has(chromeGroupId)) {
          delete windowMap[windowIdStr];
          continue;
        }

        if (desiredWindowIds.has(windowId) && !desired[groupKey]?.[windowId]) {
          try {
            const tabs = await chrome.tabs.query({ groupId: chromeGroupId });
            await ungroupTabs(tabs.map(t => t.id).filter(Boolean));
          } catch {}
          delete windowMap[windowIdStr];
        }
      }

      if (Object.keys(windowMap).length === 0) {
        delete chromeGroupMap[groupKey];
      }
    }

    // Process each virtual group
    let colorIndex = 0;
    for (const [groupKey, windowMap] of Object.entries(desired)) {
      const groupColor = assignGroupColor(groupKey, colorIndex);
      const group = domainGroups.find(g => g.domain === groupKey);
      const title = group ? getGroupTitle(group) : groupKey;
      if (!groupKey.startsWith('__session_group__:')) {
        colorIndex++;
      }

      for (const [windowIdStr, tabIds] of Object.entries(windowMap)) {
        if (tabIds.length === 0) continue;

        const windowId = Number(windowIdStr);
        let chromeGroupId = chromeGroupMap[groupKey]?.[windowId];

        // Reuse existing Chrome group if still valid
        if (chromeGroupId != null && !validGroupIds.has(chromeGroupId)) {
          chromeGroupId = null;
        }
        // A mapping can also point at a LIVE group in a DIFFERENT window than
        // the tabs being synced (stale snapshot, or window-id reuse after a
        // browser restart). Reusing it would drag these tabs across windows,
        // so drop the stale mapping and recreate the mirror locally instead.
        if (chromeGroupId != null) {
          const mappedGroup = currentGroups.find(g => Number(g.id) === Number(chromeGroupId));
          if (mappedGroup && Number(mappedGroup.windowId) !== Number(windowId)) {
            chromeGroupId = null;
          }
        }

        if (chromeGroupId == null) {
          // In import mode, only reuse existing groups — don't create new ones
          if (importMode) continue;

          // C4 follow-up: creating a mirror whose title+color fingerprint
          // already exists in this window (a user-created group, or the residue
          // of an earlier ambiguous fingerprint) would keep the identity
          // ambiguous and churn a new mirror on every load. Pick a
          // non-colliding color so the new mirror gets a unique fingerprint.
          let creationColor = groupColor;
          if (!isGroupIdentityFree(title, groupColor, windowId, currentGroups)) {
            creationColor = pickUncollidingGroupColor(title, groupColor, windowId, currentGroups);
          }

          // Create new group pinned to the synced window: without
          // createProperties.windowId Chrome creates the group in the
          // CALLER's current window and drags these tabs across windows (the
          // same contract bug fixed for session restore in be61745).
          try {
            chromeGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
          } catch {
            // Some tabs may have valid IDs but fail grouping; try one by one
            for (const tabId of tabIds) {
              try {
                if (chromeGroupId == null) {
                  chromeGroupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });
                } else {
                  await chrome.tabs.group({ groupId: chromeGroupId, tabIds: tabId });
                }
              } catch {}
            }
          }

          if (chromeGroupId != null) {
            try {
              await chrome.tabGroups.update(chromeGroupId, { title, color: creationColor, collapsed: true });
            } catch {}
          }
        } else {
          // Move tabs into existing group
          try {
            await chrome.tabs.group({ groupId: chromeGroupId, tabIds });
          } catch {}
        }

        if (chromeGroupId != null) {
          await reorderGroupedTabs(chromeGroupId, tabIds, windowId);
        }

        // Track the mapping
        if (chromeGroupId != null) {
          if (!chromeGroupMap[groupKey]) chromeGroupMap[groupKey] = {};
          chromeGroupMap[groupKey][windowId] = chromeGroupId;
        }
      }
    }

    // The dashboard no longer reorders the whole window tab strip: card order
    // follows Chrome's group strip order (see queryUserChromeGroups), so the
    // window layout is left to the user.
    await persistChromeGroupMap();
  }

  async function resetChromeGroupState() {
    chromeGroupMap = {};
    cachedEnabled = false;
    importMode = false;
    chromeEventMuteUntil = 0;
    try {
      await chrome.storage.local.remove(META_PERSIST_KEY);
    } catch {}
  }

  function isChromeTabGroupsEnabled() {
    return cachedEnabled;
  }

  function getChromeGroupCount() {
    return Object.keys(chromeGroupMap).length;
  }

  async function populateChromeGroupMap(mappings) {
    for (const { virtualGroupKey, windowId, chromeGroupId } of mappings) {
      if (!chromeGroupMap[virtualGroupKey]) chromeGroupMap[virtualGroupKey] = {};
      chromeGroupMap[virtualGroupKey][windowId] = chromeGroupId;
    }
    await persistChromeGroupMap();
  }

  async function queryExistingChromeGroups() {
    try {
      return await chrome.tabGroups.query({});
    } catch {
      return [];
    }
  }

  async function collapseChromeTabGroupsInWindow(windowId) {
    if (!cachedEnabled || !isChromeApiAvailable()) return;

    const targetWindowId = Number(windowId);
    if (!Number.isFinite(targetWindowId)) return;

    let groups = [];
    try {
      groups = await chrome.tabGroups.query({ windowId: targetWindowId });
    } catch {
      return;
    }

    // Only dashboard-managed mirror groups are collapsed. User-created groups
    // keep whatever collapsed state the user chose — this helper runs when the
    // Tab Harbor new-tab page gains focus, and must not fight the user's own
    // group layout.
    const managed = getManagedChromeGroupIds();
    const groupsInWindow = groups.filter(group => managed.has(group.id));
    muteChromeGroupEvents();

    for (const group of groupsInWindow) {
      if (Boolean(group.collapsed)) continue;
      try {
        await chrome.tabGroups.update(group.id, { collapsed: true });
      } catch {}
    }
  }

  async function syncChromeTabGroupExpansionForTab(tab) {
    if (!cachedEnabled || !isChromeApiAvailable()) return;

    const targetGroupId = Number(tab?.groupId);
    const targetWindowId = Number(tab?.windowId);
    if (!Number.isFinite(targetGroupId) || targetGroupId < 0) return;
    if (!Number.isFinite(targetWindowId)) return;

    let groups = [];
    try {
      groups = await chrome.tabGroups.query({ windowId: targetWindowId });
    } catch {
      return;
    }

    // Expand/collapse applies to dashboard-managed mirror groups only; the
    // user's own groups keep their state. If the focused group itself is a
    // user group, leave every group untouched.
    const managed = getManagedChromeGroupIds();
    if (!managed.has(targetGroupId)) return;
    const groupsInWindow = groups.filter(group => managed.has(group.id));
    muteChromeGroupEvents();

    for (const group of groupsInWindow) {
      const nextCollapsed = group.id !== targetGroupId;
      if (Boolean(group.collapsed) === nextCollapsed) continue;
      try {
        await chrome.tabGroups.update(group.id, { collapsed: nextCollapsed });
      } catch {}
    }
  }

  function setImportMode(enabled) {
    importMode = Boolean(enabled);
  }

  function isImportMode() {
    return importMode;
  }

  function subscribeToChromeTabGroupChanges(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    attachChromeListeners();
    chromeGroupSubscribers.add(listener);
    return () => {
      chromeGroupSubscribers.delete(listener);
    };
  }

  const api = {
    loadChromeTabGroupsSetting,
    saveChromeTabGroupsSetting,
    syncChromeTabGroups,
    resetChromeGroupState,
    isChromeTabGroupsEnabled,
    getChromeGroupCount,
    getManagedChromeGroupIds,
    queryUserChromeGroups,
    getChromeGroupsLastError,
    reorderGroupedTabs,
    muteChromeGroupEvents,
    populateChromeGroupMap,
    queryExistingChromeGroups,
    collapseChromeTabGroupsInWindow,
    syncChromeTabGroupExpansionForTab,
    setImportMode,
    isImportMode,
    subscribeToChromeTabGroupChanges,
    loadPersistedChromeGroupMap,
    persistChromeGroupMap,
    STORAGE_KEY,
    assignGroupColor,
    getGroupTitle,
    isGroupIdentityFree,
    pickUncollidingGroupColor,
    currentMappingCandidates,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  globalScope.TabOutChromeTabGroups = api;

})(typeof globalThis !== 'undefined' ? globalThis : window);
