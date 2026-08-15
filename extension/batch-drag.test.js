'use strict';

// Behavioral + source-contract tests for the dashboard tab-row multi-select
// and batch-drag feature (commit 40378a8 and its follow-up fixes).
//
// Unlike the regex-only ui-regression tests, the first group here EXECUTES the
// real order-building helpers extracted from dashboard-runtime.js, so a wrong
// drop position or a duplicated chip actually fails the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimeJs = fs.readFileSync(path.join(__dirname, 'dashboard-runtime.js'), 'utf8');

// ---------------------------------------------------------------------------
// Extract a top-level `function NAME(...) { ... }` body by brace matching.
// ---------------------------------------------------------------------------
function extractFn(source, name) {
  const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(m.index, i + 1);
}

function chipNode(id) {
  return { dataset: { chipSortId: id } };
}

function placeholderNode() {
  return { __placeholder: true };
}

// ---------------------------------------------------------------------------
// Behavioral: buildBatchOrderedIdsFromList
// ---------------------------------------------------------------------------
test('buildBatchOrderedIdsFromList places the whole batch at the drop point', () => {
  const fn = new Function(`${extractFn(runtimeJs, 'buildBatchOrderedIdsFromList')}\nreturn buildBatchOrderedIdsFromList;`)();
  const list = (children) => ({ children });

  // Batch dragged below the last row.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  assert.deepEqual(
    fn(list([chipNode('A'), chipNode('B'), chipNode('C'), chipNode('D'), chipNode('E'), globalThis.pageChipPlaceholderEl]), ['B', 'C', 'D']),
    ['A', 'E', 'B', 'C', 'D']
  );

  // Batch dragged to the top.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  assert.deepEqual(
    fn(list([globalThis.pageChipPlaceholderEl, chipNode('A'), chipNode('B'), chipNode('C'), chipNode('D'), chipNode('E')]), ['B', 'C', 'D']),
    ['B', 'C', 'D', 'A', 'E']
  );

  // Non-contiguous selection {A, C} dropped between C and D.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  assert.deepEqual(
    fn(list([chipNode('A'), chipNode('B'), chipNode('C'), globalThis.pageChipPlaceholderEl, chipNode('D')]), ['A', 'C']),
    ['B', 'A', 'C', 'D']
  );

  // Unselected row dragged while others are selected: only the dragged row moves.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  assert.deepEqual(
    fn(list([chipNode('A'), chipNode('B'), chipNode('C'), globalThis.pageChipPlaceholderEl, chipNode('D')]), ['A']),
    ['B', 'C', 'A', 'D']
  );

  // Batch containing a row foreign to this list (cross-card selection dropped
  // on the source card): the foreign row is ignored, the rest reorders.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  assert.deepEqual(
    fn(list([chipNode('A'), chipNode('B'), globalThis.pageChipPlaceholderEl, chipNode('C')]), ['B', 'X']),
    ['A', 'B', 'C']
  );

  // Dragged chip sits later in the DOM than the placeholder.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  assert.deepEqual(
    fn(list([globalThis.pageChipPlaceholderEl, chipNode('A'), chipNode('B'), chipNode('C'), chipNode('D'), chipNode('E')]), ['C', 'D']),
    ['C', 'D', 'A', 'B', 'E']
  );

  // Drop at the bottom of a card with collapsed overflow rows: the placeholder
  // sits right before the collapsed block (index 8), so the batch lands as the
  // last VISIBLE row and must not fall into the collapsed section.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  assert.deepEqual(
    fn(list([chipNode('c1'), chipNode('c2'), chipNode('c3'), chipNode('c4'), chipNode('c5'), chipNode('c6'), chipNode('c7'), chipNode('c8'), globalThis.pageChipPlaceholderEl, chipNode('c9'), chipNode('c10')]), ['c1']),
    ['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c1', 'c9', 'c10']
  );
});

test('buildBatchOrderedIdsFromList ignores non-chip children when computing the drop index', () => {
  const fn = new Function(`${extractFn(runtimeJs, 'buildBatchOrderedIdsFromList')}\nreturn buildBatchOrderedIdsFromList;`)();
  // A card with an overflow "+N more" row (no chipSortId) between A and the
  // placeholder; dropping B after the overflow row must land B between the
  // overflow row and C, not after C.
  const overflow = { dataset: {} };
  globalThis.pageChipPlaceholderEl = placeholderNode();
  const list = { children: [chipNode('A'), overflow, globalThis.pageChipPlaceholderEl, chipNode('B'), chipNode('C')] };
  assert.deepEqual(fn(list, ['B']), ['A', 'B', 'C']);
});

// ---------------------------------------------------------------------------
// Behavioral: buildBatchMergeGroupTitle
// ---------------------------------------------------------------------------
test('buildBatchMergeGroupTitle derives the group name from tab content', () => {
  const fn = new Function(`
    ${extractFn(runtimeJs, 'buildBatchMergeGroupTitle')}
    return buildBatchMergeGroupTitle;
  `)();
  // id → { url, title }: 0-2 same domain, 3 a different domain, 4 unresolvable.
  const tabs = [
    { id: 0, url: 'https://github.com/foo', title: 'Foo · GitHub' },
    { id: 1, url: 'https://github.com/bar', title: 'Bar · GitHub' },
    { id: 2, url: 'https://github.com/baz', title: 'Baz · GitHub' },
    { id: 3, url: 'https://news.ycombinator.com/item', title: 'HN item' },
    { id: 4, url: 'chrome://settings', title: 'Settings page' },
  ];
  globalThis.getTabsByIds = (ids) => tabs.filter(t => ids.includes(t.id));
  globalThis.friendlyDomain = (hostname) => String(hostname || '').split('.')[0];
  globalThis.runtimeT = null;

  // Single domain → bare site name; github.com keeps its canonical casing.
  assert.equal(fn([0, 1, 2]), 'GitHub');
  // Mixed domains → most frequent domain with a ×count suffix.
  assert.equal(fn([0, 1, 3]), 'GitHub ×2');
  // Unresolvable URL → first tab's title.
  assert.equal(fn([4]), 'Settings page');
  delete globalThis.getTabsByIds;
  delete globalThis.friendlyDomain;
  delete globalThis.runtimeT;
});

// ---------------------------------------------------------------------------
// Behavioral: buildCrossGroupTargetOrder
// ---------------------------------------------------------------------------
test('buildCrossGroupTargetOrder moves the whole batch contiguously without duplicates', () => {
  const fn = new Function(`${extractFn(runtimeJs, 'buildCrossGroupTargetOrder')}\nreturn buildCrossGroupTargetOrder;`)();

  // Target card already contains X (a selected row of this card); batch
  // [B, X] dropped between A and D must land as one contiguous block.
  globalThis.pageChipPlaceholderEl = placeholderNode();
  const list = { children: [chipNode('A'), globalThis.pageChipPlaceholderEl, chipNode('X'), chipNode('D')] };
  assert.deepEqual(fn(list, ['B', 'X']), ['A', 'B', 'X', 'D']);

  // Batch appended at the end when there is no placeholder.
  globalThis.pageChipPlaceholderEl = null;
  assert.deepEqual(fn({ children: [chipNode('A'), chipNode('D')] }, ['B', 'X']), ['A', 'D', 'B', 'X']);

  // Non-chip children before the placeholder must not skew the insert index.
  const overflow = { dataset: {} };
  globalThis.pageChipPlaceholderEl = placeholderNode();
  const list2 = { children: [chipNode('A'), overflow, globalThis.pageChipPlaceholderEl, chipNode('X'), chipNode('D')] };
  assert.deepEqual(fn(list2, ['B', 'X']), ['A', 'B', 'X', 'D']);
});

// ---------------------------------------------------------------------------
// Behavioral: normalizeGroupTabOrderState keeps the first occurrence
// ---------------------------------------------------------------------------
test('normalizeGroupTabOrderState dedupes keeping the first occurrence', () => {
  const fn = new Function(`${extractFn(runtimeJs, 'normalizeGroupTabOrderState')}\nreturn normalizeGroupTabOrderState;`)();
  assert.deepEqual(fn({ g: ['A', 'B', 'X', 'X', 'D'] }).g, ['A', 'B', 'X', 'D']);
});

// ---------------------------------------------------------------------------
// Behavioral: getMovingPageChipIds — snapshot preference + visual DOM order
// ---------------------------------------------------------------------------
test('getMovingPageChipIds prefers the drag-start snapshot and keeps visual order', () => {
  // Stub `document` with two cards: card1 [A, B, C], card2 [X].
  const fakeDocument = {
    querySelectorAll: () => [
      { querySelectorAll: () => [chipNode('A'), chipNode('B'), chipNode('C')] },
      { querySelectorAll: () => [chipNode('X')] },
    ],
  };
  const fn = new Function(
    `${extractFn(runtimeJs, 'orderChipIdsByDom')}\n${extractFn(runtimeJs, 'getMovingPageChipIds')}\nreturn getMovingPageChipIds;`
  )();

  globalThis.document = fakeDocument;

  // No snapshot: dragged row is selected -> whole selection, in DOM order even
  // if the user toggled rows in a different order (X toggled first).
  globalThis.pageChipDragState = null;
  globalThis.selectedPageChipIds = new Set(['X', 'B']);
  globalThis.draggedPageChipId = 'B';
  assert.deepEqual(fn(), ['B', 'X']);

  // No snapshot: dragged row not selected -> only the dragged row.
  globalThis.draggedPageChipId = 'A';
  assert.deepEqual(fn(), ['A']);

  // Snapshot wins even when the live selection changed mid-drag (Escape).
  globalThis.pageChipDragState = { movingChipIds: ['B', 'C'] };
  globalThis.selectedPageChipIds = new Set();
  globalThis.draggedPageChipId = 'B';
  assert.deepEqual(fn(), ['B', 'C']);
});

// ---------------------------------------------------------------------------
// Source contracts for the flow-level fixes (would regress silently otherwise)
// ---------------------------------------------------------------------------
test('same-group reorder commits use the drag-start snapshot, not the live selection', () => {
  assert.match(runtimeJs, /if \(targetGroupKey && targetGroupKey === sourceGroupKey && targetListEl\) \{[\s\S]{0,400}const movingIds = getMovingPageChipIds\(\);\s*const orderIds = buildBatchOrderedIdsFromList\(targetListEl, movingIds\);/);
});

test('Escape cancels an in-flight drag before clearing the selection', () => {
  assert.match(runtimeJs, /if \(e\.key !== 'Escape'\) return;[\s\S]{0,200}if \(draggedPageChipId && pageChipDragState\) \{\s*clearPageChipDragState\(\{ removeNode: false \}\);/);
});

test('handle press that never moved toggles; completed drags are never clicks', () => {
  assert.match(runtimeJs, /if \(!pageChipDragState\.moved && finalDistance < 4\) \{/);
});

test('whole-row drag: the row body arms the same drag as the handle', () => {
  // The handle is the visible grip, but a press anywhere on the row body
  // arms the drag too — no need to aim for the 30px grip.
  assert.match(runtimeJs, /if \(chipItem && !chipAction && e\.button === 0\) \{/);
  assert.match(runtimeJs, /const dragHandleEl = chipHandle \|\| item;/);
  assert.match(runtimeJs, /originatedFromHandle: Boolean\(chipHandle\),/);
});

test('a completed drag suppresses the click that follows it', () => {
  // The click dispatched right after pointerup must not activate the tab; the
  // suppression is set synchronously in pointerup, before the async commit.
  assert.match(runtimeJs, /suppressPageChipClickUntil = Date\.now\(\) \+ 250;\s*updateDraggedPageChipPosition\(e\.clientX, e\.clientY\);/);
});

test('multi-select mode: clicking a row toggles it instead of activating the tab', () => {
  // While a selection exists, focus-tab becomes a toggle: the row body never
  // jumps to the tab in batch mode.
  assert.match(runtimeJs, /if \(action === 'focus-tab'\) \{/);
  assert.match(runtimeJs, /if \(selectedPageChipIds\.size > 0\) \{\s*if \(key\) \{[\s\S]{0,300}if \(e\.shiftKey && pageChipSelectionAnchorId\) \{\s*selectPageChipRange\(key, pageChipSelectionAnchorId\);\s*\} else \{\s*togglePageChipSelection\(key\);/);
  // A plain body click (no selection yet) stays a click and activates the tab.
  assert.match(runtimeJs, /const tabUrl = actionEl\.dataset\.tabUrl;\s*const tabId = actionEl\.dataset\.tabId \|\| '';\s*if \(tabUrl \|\| tabId\) await focusTab\(tabUrl, tabId\);/);
  // Body presses only toggle on click while a selection is active.
  assert.match(runtimeJs, /const toggleAsClick = pageChipDragState\.originatedFromHandle\s*\|\| selectedPageChipIds\.size > 0\s*\|\| e\.shiftKey;/);
  // Deselecting the last row must not make the follow-up click jump to it;
  // the guard checks key + window only (no keydown bypass — row bodies are
  // not keyboard-focusable, so a recent keydown must not re-toggle the row).
  assert.match(runtimeJs, /const toggleGuardHit = Boolean\(key\)\s*&& pageChipPointerToggleGuard\.key === key\s*&& Date\.now\(\) < pageChipPointerToggleGuard\.until;\s*if \(toggleGuardHit\) return;/);
  assert.doesNotMatch(runtimeJs, /const toggleGuardHit = Boolean\(key\)[\s\S]{0,60}Date\.now\(\) - pageChipLastKeydownAt > 120/);
});

test('section header above all cards adds global close-duplicates and merge-all', () => {
  // buildOpenTabsSectionActions drives both render paths of the open-tabs
  // section header; close-duplicates appears only while some card-visible URL
  // is duplicated anywhere in the window (getRealTabs scope — internal pages
  // and the dashboard's own new-tab page never inflate the count).
  assert.match(runtimeJs, /function buildOpenTabsSectionActions\(\) \{[\s\S]{0,500}const counts = \{\};\s*for \(const tab of getRealTabs\(\)\) \{[\s\S]{0,200}const dupeUrls = Object\.entries\(counts\)\s*\.filter\(\(\[, c\]\) => c > 1\)/);
  assert.match(runtimeJs, /data-action="dedup-keep-one" data-dupe-urls="\$\{dupeUrlsEncoded\}"/);
  assert.match(runtimeJs, /data-action="group-card-tabs" data-scope="all"/);
  assert.match(runtimeJs, /openTabsSectionCount\.innerHTML = buildOpenTabsSectionActions\(\);/);
  // The all-scope branch collects every card's ordered unique tabs.
  assert.match(runtimeJs, /const scope = actionEl\.dataset\.scope \|\| '';/);
  assert.match(runtimeJs, /if \(scope === 'all'\) \{[\s\S]{0,300}for \(const g of domainGroups\) \{[\s\S]{0,200}getOrderedUniqueTabsForGroup\(g\)/);
});

test('merge-all is titled with its real tab count and retries once on stale ids', () => {
  // The group title reflects what was actually merged (scope="all" excludes
  // pinned and non-restorable tabs), so the count is part of the label.
  assert.match(runtimeJs, /const label = scope === 'all'\s*\?\s*\(runtimeT \? runtimeT\('mergeAllGroupTitle', \{ count: tabIds\.length \}\) : `Open tabs \(\$\{tabIds\.length\}\)`\)/);
  // chrome.tabs.group fails atomically on any invalid id; drop ids that no
  // longer exist and retry once with the survivors.
  assert.match(runtimeJs, /async function groupTabsWithStaleRetry\(tabIds\) \{[\s\S]{0,200}return await chrome\.tabs\.group\(\{ tabIds \}\);\s*\} catch \(err\) \{[\s\S]{0,250}const liveIds = \[\];[\s\S]{0,200}try \{ await chrome\.tabs\.get\(id\); liveIds\.push\(id\); \} catch/);
  assert.match(runtimeJs, /const groupId = await groupTabsWithStaleRetry\(tabIds\);/);
  const i18nJs = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8');
  assert.match(i18nJs, /mergeAllGroupTitle: 'Open tabs \(\{count\}\)'/);
  assert.match(i18nJs, /mergeAllGroupTitle: '打开的标签页 \(\{count\}\)'/);
});

test('every re-render re-syncs the batch bar so the header title stays consistent', () => {
  // renderOpenTabsArea ends by re-applying the selection classes, which also
  // re-runs syncPageChipBatchBar — a full refresh while rows are selected
  // restores the "N selected" title instead of leaving it on "Open tabs".
  assert.match(runtimeJs, /\/\/ Re-apply the selection highlight and prune ids whose rows are gone; this[\s\S]{0,400}refreshPageChipSelectionClasses\(\);/);
});

test('merge-all skips pinned tabs; the tab snapshot carries the pinned flag', () => {
  // The section-header merge folds every card's tabs into one Chrome group
  // but leaves pinned tabs outside it.
  assert.match(runtimeJs, /if \(tab\?\.pinned\) continue;/);
  assert.match(runtimeJs, /pinned:\s*Boolean\(t\.pinned\),/);
});

test('close-single-tab tolerates a tab that vanished before the click', () => {
  // removeOpenTabByIdOrUrl wraps chrome.tabs.remove in try/catch so a stale id
  // cannot produce an unhandled rejection that skips the toast/animation.
  assert.match(runtimeJs, /async function removeOpenTabByIdOrUrl\(tabId, tabUrl\) \{[\s\S]{0,200}try \{[\s\S]{0,120}await chrome\.tabs\.remove\(numericTabId\);[\s\S]{0,80}\} catch \{\s*\/\* tab already gone[\s\S]{0,80}return null;/);
});

test('close-duplicates keeps every window\'s last tab like the other close paths', () => {
  // closeDuplicateTabs routes its removals through ensureWindowsKeepLastTab so
  // deduplication can never close a window (or, for the last window, Chrome).
  assert.match(runtimeJs, /const safeToClose = ensureWindowsKeepLastTab\(allTabs, toClose\);\s*if \(safeToClose\.length > 0\) await chrome\.tabs\.remove\(safeToClose\);/);
});

test('the card-header actions wrapper left no orphaned .actions CSS rule', () => {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert.doesNotMatch(css, /\.actions\s*\{/);
});

test('user-created Chrome groups become first-class cards; their tabs leave domain grouping', () => {
  // Tab snapshot carries native group membership + strip position.
  assert.match(runtimeJs, /groupId:\s*Number\.isInteger\(t\.groupId\) && t\.groupId >= 0 \? t\.groupId : -1,/);
  assert.match(runtimeJs, /index:\s*Number\.isInteger\(t\.index\) \? t\.index : 0,/);
  // buildDomainGroups queries unmanaged groups regardless of the sync toggle
  // (recognition is toggle-independent; the toggle only controls the push).
  assert.match(runtimeJs, /let userChromeGroups = \[\];\s*if \(typeof queryUserChromeGroups === 'function'\) \{/);
  assert.match(runtimeJs, /userChromeGroups = await queryUserChromeGroups\(windowId\);/);
  assert.match(runtimeJs, /const chromeOwnedTabIds = new Set\(\(userChromeGroups \|\| \[\]\)\.flatMap\(g => g\.tabIds \|\| \[\]\)\);/);
  assert.match(runtimeJs, /if \(chromeOwnedTabIds\.has\(tab\.id\)\) continue;/);
  // Chrome cards render first, in tab-strip order, with no toggle gate.
  assert.match(runtimeJs, /const chromeCards = \(userChromeGroups \|\| \[\]\)\s*\.map\(group => \(\{/);
  assert.match(runtimeJs, /domain: `\$\{CHROME_GROUP_PREFIX\}\$\{group\.id\}`,/);
  assert.match(runtimeJs, /isChromeGroup: true,/);
  assert.match(runtimeJs, /chromeGroupId: group\.id,/);
  assert.match(runtimeJs, /if \(chromeCards\.length > 0\) \{\s*domainGroups = \[\.\.\.chromeCards, \.\.\.applyGroupOrder\(\[\.\.\.manualGroups, \.\.\.automaticGroups\], groupOrderState\)\];/);
  // Native groups are recognized live; the import pipeline is retired.
  assert.match(runtimeJs, /function shouldImportChromeGroupsIntoSessionState\(\) \{[\s\S]{0,400}return false;/);
});

test('dragging into a Chrome group card joins the native group; dragging out ungroups', () => {
  // Target is a user Chrome group: chrome.tabs.group with that groupId, muted.
  assert.match(runtimeJs, /if \(targetGroup\?\.isChromeGroup && targetGroup\.chromeGroupId != null\) \{[\s\S]{0,300}if \(typeof muteChromeGroupEvents === 'function'\) muteChromeGroupEvents\(\);[\s\S]{0,200}await chrome\.tabs\.group\(\{ groupId: Number\(targetGroup\.chromeGroupId\), tabIds: draggedTabIds \}\)/);
  // Leaving a Chrome group card detaches the batch (domain/manual/new targets).
  assert.match(runtimeJs, /if \(sourceGroups\.some\(group => group\?\.isChromeGroup\)\) \{[\s\S]{0,200}if \(typeof muteChromeGroupEvents === 'function'\) muteChromeGroupEvents\(\);[\s\S]{0,200}await chrome\.tabs\.ungroup\(draggedTabIds\);/);
  assert.match(runtimeJs, /if \(sourceGroupForNew\?\.isChromeGroup\) \{[\s\S]{0,300}await chrome\.tabs\.ungroup\(unlinkCollected\.tabIds\);/);
  // In-group reorder on a Chrome card reorders the native group's tabs.
  assert.match(runtimeJs, /if \(sourceGroup\?\.isChromeGroup && sourceGroup\.chromeGroupId != null[\s\S]{0,200}await reorderGroupedTabs\(Number\(sourceGroup\.chromeGroupId\), orderIds\.map\(String\), windowId\);/);
});

test('reorderGroupedTabs normalizes string chip tokens to numeric tab ids', () => {
  const syncJs = fs.readFileSync(path.join(__dirname, 'chrome-tab-groups-sync.js'), 'utf8');
  assert.match(syncJs, /const desiredIds = desiredTabIds\s*\.map\(id => Number\(id\)\)\s*\.filter\(Number\.isFinite\);/);
  assert.match(syncJs, /const desiredSet = new Set\(desiredIds\.map\(String\)\);/);
  assert.match(syncJs, /\.filter\(tab => desiredSet\.has\(String\(tab\.id\)\)\)/);
});

test('card refresh is not gated by the import suppression window', () => {
  // The subscription re-renders live cards unconditionally (pure read); the
  // import schedule stays toggle- and suppression-gated.
  assert.match(runtimeJs, /subscribeToChromeTabGroupChanges\(\(event = \{\}\) => \{/);
  assert.match(runtimeJs, /if \(Date\.now\(\) >= \(window\.__suppressAutoRefreshUntil \|\| 0\)\) \{/);
  assert.match(runtimeJs, /void renderDashboard\(\);/);
  assert.match(runtimeJs, /if \(chromeTabGroupsEnabled && !isChromeTabGroupsImportSuppressed\(\)\) \{\s*scheduleChromeTabGroupsImport\(\);/);
});

test('a tab dragged into a native group outside the dashboard drops its manual assignment (C14)', () => {
  // The subscription callback watches events carrying a tab/groupId and clears
  // the manual session-group assignment for tabs that now belong to a native
  // group, so the next render cannot show them in two cards. tabs.onAttached
  // has no tab object, so the callback also resolves a raw tabId live.
  assert.match(runtimeJs, /const eventTab = event\?\.tab;/);
  assert.match(runtimeJs, /event\?\.tab\?\.groupId \?\? event\?\.changeInfo\?\.groupId \?\? event\?\.attachInfo\?\.groupId \?\? -1/);
  assert.match(runtimeJs, /const rawTabId = eventTab\?\.id != null \? Number\(eventTab\.id\) : \(event\?\.tabId != null \? Number\(event\.tabId\) : null\);/);
  assert.match(runtimeJs, /const resolveCleanup = async \(tabId\) => \{/);
  assert.match(runtimeJs, /const live = await chrome\.tabs\.get\(tabId\);/);
  assert.match(runtimeJs, /if \(rawTabId != null && Number\(eventGroupId\) >= 0\) \{\s*void resolveCleanup\(rawTabId\);/);
  assert.match(runtimeJs, /clearTabsFromSessionGroups\(sessionGroupsState, \[tabId\]\);/);
  // C6: the cleanup does NOT write the raw nextState back in a .then — that
  // would clobber saveSessionGroups' normalized assignment.
  assert.match(runtimeJs, /void saveSessionGroups\(nextState\);/);
  assert.doesNotMatch(runtimeJs, /void saveSessionGroups\(nextState\)\.then\(\(\) => \{\s*if \(sessionGroupsState\) sessionGroupsState = nextState;/);
});

test('cross-card drop into a Chrome group persists the drop order (C7)', () => {
  // After chrome.tabs.group, the dropped tabs are reordered to the drop order
  // so the native strip matches the panel; a stale windowId is never used.
  assert.match(runtimeJs, /const firstWindowId = draggedTabIds\.length\s*\? \(await chrome\.tabs\.get\(draggedTabIds\[0\]\)\.catch\(\(\) => null\)\)\?\.windowId/);
  assert.match(runtimeJs, /if \(firstWindowId != null && typeof reorderGroupedTabs === 'function'\) \{/);
  assert.match(runtimeJs, /reorderGroupedTabs\(Number\(targetGroup\.chromeGroupId\), draggedTabIds\.map\(String\), Number\(firstWindowId\)\)/);
});

test('sleep/discard failures reset the refresh suppression window (C8)', () => {
  // Every path that raises __suppressAutoRefreshUntil must reset it before an
  // early return, or the next 2s of auto-refresh are silently dropped.
  const suppressSets = (runtimeJs.match(/window\.__suppressAutoRefreshUntil = Date\.now\(\) \+ 2000;/g) || []).length;
  const resets = (runtimeJs.match(/window\.__suppressAutoRefreshUntil = 0;/g) || []).length;
  assert.ok(suppressSets >= 6, `expected >=6 suppress sets, got ${suppressSets}`);
  assert.ok(resets >= 6, `expected >=6 resets, got ${resets}`);
  // Failed single-tab discard resets.
  assert.match(runtimeJs, /if \(!discarded\) \{\s*window\.__suppressAutoRefreshUntil = 0;/);
  // Failed group/all sleep resets.
  assert.match(runtimeJs, /if \(!succeeded\) \{\s*window\.__suppressAutoRefreshUntil = 0;/);
});

test('chrome group cards survive a lagging tab snapshot with a placeholder row (C12)', () => {
  // A tab id the openTabs snapshot has not materialized yet falls back to a
  // minimal placeholder instead of emptying the whole card.
  assert.match(runtimeJs, /const live = openTabs\.find\(t => Number\(t\.id\) === Number\(id\)\);/);
  assert.match(runtimeJs, /return live \|\| \{ id: Number\(id\), url: '', title: '', windowId: Number\(group\.windowId\), groupId: Number\(group\.id\) \};/);
});

test('chrome group cards pass through custom hex colors and map named enum colors', () => {
  // Chrome 132+ custom group colors come back as raw hex; named enum colors
  // (including newer orange) map to dashboard accents. Anything unmatched
  // falls back to the grey bar instead of an invalid CSS value.
  assert.match(runtimeJs, /orange: '#d98a4b',/);
  assert.match(runtimeJs, /CHROME_GROUP_COLOR_MAP\[group\.chromeGroupColor\] \|\| \(String\(group\.chromeGroupColor \|\| ''\)\.startsWith\('#'\) \? group\.chromeGroupColor : ''\)/);
});

test('merge-all skips user-created Chrome group cards', () => {
  assert.match(runtimeJs, /if \(scope === 'all'\) \{[\s\S]{0,400}if \(g\.isChromeGroup\) continue;/);
});

test('renaming a Chrome group card renames the native Chrome group', () => {
  assert.match(runtimeJs, /if \(group\.isChromeGroup && group\.chromeGroupId != null\) \{[\s\S]{0,200}await chrome\.tabGroups\.update\(Number\(group\.chromeGroupId\), \{ title: cleanName \}\)/);
});

test('chrome group cards tint their name and row drag handles with the native color', () => {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  // No separate top bar: the group color lives on the card name and the tab
  // rows' drag handles (hover/focus keep the same tint).
  assert.doesNotMatch(css, /\.mission-card\.chrome-group-card::before/);
  // The NAME mixes the group color toward --ink (readable text, AA contrast);
  // the drag handles keep the pure group color (graphical icons).
  assert.match(css, /\.mission-card\.chrome-group-card \.mission-name \{\s*color:\s*color-mix\(in srgb, var\(--chrome-group-color, var\(--ink\)\) 55%, var\(--ink\)\);/);
  assert.match(css, /\.mission-card\.chrome-group-card \.chip-reorder-handle \{\s*color:\s*var\(--chrome-group-color,/);
  assert.match(css, /\.mission-card\.chrome-group-card \.chip-reorder-handle:hover,[\s\S]{0,120}color:\s*var\(--chrome-group-color,\s*var\(--ink\)\);/);
  // The tint is also inlined onto the handle at render time, so it cannot be
  // lost to CSS cascade/ordering against .drawer-reorder-handle.
  assert.match(runtimeJs, /const chromeGroupColor = group\?\.isChromeGroup\s*\?[\s\S]{0,160}CHROME_GROUP_COLOR_MAP\[group\.chromeGroupColor\][\s\S]{0,80}startsWith\('#'\)/);
  assert.match(runtimeJs, /class="drawer-reorder-handle chip-reorder-handle" type="button" data-chip-drag-handle="tab"[\s\S]{0,160}\$\{chromeGroupColor \? ` style="color:\$\{chromeGroupColor\}"` : ''\}/);
  assert.doesNotMatch(runtimeJs, /function darkenHexColor/);
  assert.match(runtimeJs, /const CHROME_GROUP_COLOR_MAP = \{[\s\S]{0,300}cyan: '#5ba8b3',/);
});

test('an invalidated extension context recovers by reloading the page once', () => {
  // Extension reload/update while the dashboard is open makes every chrome.*
  // call throw "Extension context invalidated". The refresh catch detects it
  // and reloads the page once so it rebinds to the live context.
  assert.match(runtimeJs, /function isExtensionContextInvalidated\(err\) \{[\s\S]{0,200}\/Extension context invalidated\/i/);
  assert.match(runtimeJs, /let extensionContextInvalidatedHandled = false;[\s\S]{0,200}if \(extensionContextInvalidatedHandled\) return;[\s\S]{0,250}location\.reload\(\);/);
  assert.match(runtimeJs, /console\.warn\('\[tab-harbor\] Failed to refresh dashboard:', err\);\s*if \(isExtensionContextInvalidated\(err\)\) recoverFromInvalidatedExtensionContext\(\);/);
  // User-triggered chrome calls after invalidation reject too — the global
  // unhandled-rejection net routes them to the same single recovery.
  assert.match(runtimeJs, /window\.addEventListener\('unhandledrejection', \(event\) => \{[\s\S]{0,200}isExtensionContextInvalidated\(event\?\.reason\)\) recoverFromInvalidatedExtensionContext\(\);/);
});

test('pointerup parks the placeholder at the release point (fast-flick fix)', () => {
  assert.match(runtimeJs, /if \(!stickyIsNonSource\) \{\s*(?:\/\/[^\n]*\n\s*)*previewPageChipOrder\(e\.clientX, e\.clientY\);/);
});

test('dragging a tab chip near the top/bottom edge auto-scrolls the page', () => {
  assert.match(runtimeJs, /const PAGE_CHIP_EDGE_SCROLL_ZONE = 64;/);
  assert.match(runtimeJs, /function stopPageChipAutoScroll\(\) \{/);
  assert.match(runtimeJs, /function updatePageChipAutoScroll\(clientX, clientY\) \{/);
  assert.match(runtimeJs, /window\.scrollBy\(0, delta\);/);
  assert.match(runtimeJs, /previewPageChipOrder\(x, y\);/);
  assert.match(runtimeJs, /function clearPageChipDragState\(\{ removeNode = false \} = \{\}\) \{\s*stopPageChipAutoScroll\(\);/);
  assert.match(runtimeJs, /pageChipDragState\.lastClientX = e\.clientX;\s*pageChipDragState\.lastClientY = e\.clientY;/);
  assert.match(runtimeJs, /previewPageChipOrder\(e\.clientX, e\.clientY\);\s*updatePageChipAutoScroll\(e\.clientX, e\.clientY\);/);
  assert.match(runtimeJs, /async function finishPageChipDrag\(\) \{\s*if \(!draggedPageChipId \|\| !pageChipDragState\) return false;[\s\S]{0,160}stopPageChipAutoScroll\(\);/);
});

test('chip drags refuse a second pointer (re-entrancy guard)', () => {
  assert.match(runtimeJs, /if \(pageChipDragState \|\| draggedPageChipId\) return;/);
});

test('selection state is exposed via aria-pressed on the handle', () => {
  assert.match(runtimeJs, /handle\.setAttribute\('aria-pressed', selected \? 'true' : 'false'\)/);
  assert.match(runtimeJs, /data-chip-drag-handle="tab" aria-pressed="\$\{isSelected \? 'true' : 'false'\}"/);
  assert.match(runtimeJs, /runtimeT\('dragReorderTabSelect'\)/);
});

test('cross-group order builder removes batch rows from the existing order before inserting', () => {
  assert.match(runtimeJs, /\.filter\(id => !movingSet\.has\(id\)\)/);
  assert.match(runtimeJs, /const movingSet = new Set\(\(movingIds \|\| \[\]\)\.map\(String\)\.filter\(Boolean\)\);[\s\S]{0,400}\.filter\(id => !movingSet\.has\(id\)\)/);
});

test('moving set is ordered by visual DOM position', () => {
  assert.match(runtimeJs, /function orderChipIdsByDom\(ids\) \{/);
  assert.match(runtimeJs, /return orderChipIdsByDom\(ids\);/);
});

test('stale selection ids are pruned and the batch bar follows the selection', () => {
  assert.match(runtimeJs, /for \(const id of selectedPageChipIds\) \{\s*if \(!seen\.has\(id\)\) \{\s*selectedPageChipIds\.delete\(id\);\s*if \(pageChipSelectionAnchorId === id\) pageChipSelectionAnchorId = '';/);
  assert.match(runtimeJs, /function clearPageChipSelection\(\) \{\s*selectedPageChipIds\.clear\(\);\s*pageChipSelectionAnchorId = '';/);
  assert.match(runtimeJs, /function syncPageChipBatchBar\(\) \{/);
  assert.match(runtimeJs, /function selectPageChipRange\(targetId, anchorId\) \{/);
});

test('keyboard activation toggles selection; pointer clicks stay on the pointerup path', () => {
  assert.match(runtimeJs, /if \(e\.detail === 0 && !\(draggedPageChipId && pageChipDragState\)\) \{/);
});

test('batch actions run in user order: clear, dedup, merge, sleep, save, close', () => {
  // The bar renders left-to-right: clear selection, close selected
  // duplicates, merge into Chrome group, sleep (conditional), save, close.
  const barHtml = runtimeJs.match(/bar\.innerHTML = `([\s\S]*?)`;/)?.[1] || '';
  const order = [
    'clear-chip-selection',
    'batch-dedup-selection',
    'batch-merge-chrome-group',
    'batch-discard-tabs',
    'batch-save-session',
    'batch-close-tabs',
  ];
  let cursor = 0;
  for (const action of order) {
    const idx = barHtml.indexOf(`data-action="${action}"`);
    assert.ok(idx !== -1, `missing batch action ${action}`);
    assert.ok(idx >= cursor, `batch action ${action} out of order`);
    cursor = idx;
  }
  // Every batch action is an icon button with a themed tooltip, matching the
  // section-header icon actions (aria-label + data-tooltip + inline SVG).
  assert.match(runtimeJs, /data-action="batch-close-tabs" aria-label="\$\{runtimeT \? runtimeT\('batchCloseTabs'\) : 'Close selected'\}" data-tooltip="\$\{runtimeT \? runtimeT\('batchCloseTabs'\) : 'Close selected'\}">\$\{ICONS\.close\}/);
  assert.match(runtimeJs, /data-action="batch-discard-tabs" aria-label="\$\{runtimeT \? runtimeT\('batchSleepTabs'\) : 'Sleep selected'\}" data-tooltip="\$\{runtimeT \? runtimeT\('batchSleepTabs'\) : 'Sleep selected'\}">\$\{ICONS\.moon\}/);
  assert.match(runtimeJs, /data-action="batch-merge-chrome-group" aria-label="\$\{runtimeT \? runtimeT\('batchMergeChromeGroup'\) : 'Merge into Chrome group'\}" data-tooltip="\$\{runtimeT \? runtimeT\('batchMergeChromeGroup'\) : 'Merge into Chrome group'\}">\$\{ICONS\.mergeGroup\}/);
  assert.match(runtimeJs, /data-action="batch-dedup-selection" aria-label="\$\{runtimeT \? runtimeT\('batchCloseDuplicates'\) : 'Close selected duplicates'\}" data-tooltip="\$\{runtimeT \? runtimeT\('batchCloseDuplicates'\) : 'Close selected duplicates'\}">\$\{ICONS\.closeDuplicates\}/);
  assert.match(runtimeJs, /data-action="batch-save-session" aria-label="\$\{runtimeT \? runtimeT\('batchSaveSession'\) : 'Save session'\}" data-tooltip="\$\{runtimeT \? runtimeT\('batchSaveSession'\) : 'Save session'\}">\$\{ICONS\.archive\}/);
  assert.match(runtimeJs, /data-action="clear-chip-selection" aria-label="\$\{runtimeT \? runtimeT\('batchClearSelection'\) : 'Clear selection'\}" data-tooltip="\$\{runtimeT \? runtimeT\('batchClearSelection'\) : 'Clear selection'\}">\$\{ICONS\.deselect\}/);
  assert.match(runtimeJs, /openTabSessionPicker\(\{\s*source: 'selected',\s*initialTabIds: tabIds,\s*scopeTabIds: tabIds,\s*\}\)/);
  // The batch buttons are 30px icon buttons with tooltips, and their tooltips
  // are registered in the shared tooltip CSS (hover + focus-visible).
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert.match(css, /\.page-chip-batch-action \[data-tooltip\]::after,|\.page-chip-batch-action\[data-tooltip\]::after,/);
  assert.match(css, /\.page-chip-batch-action\[data-tooltip\]:hover::after,/);
  assert.match(css, /\.page-chip-batch-action svg \{\s*width: 14px;\s*height: 14px;/);
});

test('batch dedup closes duplicates inside the selection only, keeping one per URL', () => {
  // The handler scopes dedup to the selected tab ids (getTabsByIds), keeps the
  // active copy, and routes removals through ensureWindowsKeepLastTab.
  assert.match(runtimeJs, /if \(action === 'batch-dedup-selection'\) \{/);
  assert.match(runtimeJs, /const selectedTabs = getTabsByIds\(tabIds\);/);
  assert.match(runtimeJs, /const keep = tabs\.find\(t => t\.active\) \|\| tabs\[0\];/);
  assert.match(runtimeJs, /const safeToClose = ensureWindowsKeepLastTab\(allTabs, toClose\);/);
  assert.match(runtimeJs, /await chrome\.tabs\.remove\(tabId\);\s*closedCount \+= 1;\s*closedTabIds\.add\(Number\(tabId\)\);/);
  assert.match(runtimeJs, /const chipTabIds = getPageChipTabIdMap\(\);/);
  assert.match(runtimeJs, /const keptChipIds = \[\.\.\.selectedPageChipIds\]\.filter\(chipId => \{/);
  assert.match(runtimeJs, /selectedPageChipIds = new Set\(keptChipIds\);/);
  assert.match(runtimeJs, /toastBatchClosedDuplicates', \{ count: closedCount \}\)/);
  assert.match(runtimeJs, /toastBatchNoDuplicates/);
  const i18nJs = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8');
  assert.match(i18nJs, /batchCloseDuplicates: 'Close selected duplicates'/);
  assert.match(i18nJs, /batchCloseDuplicates: '关闭选中重复标签'/);
  assert.match(i18nJs, /toastBatchClosedDuplicates: 'Closed \{count\} duplicate tabs'/);
  assert.match(i18nJs, /toastBatchClosedDuplicates: '已关闭 \{count\} 个重复标签页'/);
  assert.match(i18nJs, /toastBatchNoDuplicates: 'No duplicate tabs in selection'/);
  assert.match(i18nJs, /toastBatchNoDuplicates: '所选标签页中没有重复'/);
});

test('batch merge folds the selection into one new Chrome tab group, muted', () => {
  // The batch bar button maps to its own handler.
  assert.match(runtimeJs, /if \(action === 'batch-merge-chrome-group'\) \{/);
  // Pinned tabs stay outside the merged group (mirrors the section-header
  // merge-all) and the write is muted so the dashboard cannot echo it.
  assert.match(runtimeJs, /const pinnedIds = new Set\(\(openTabs \|\| \[\]\)\.filter\(t => t\?\.pinned\)\.map\(t => Number\(t\.id\)\)\);/);
  assert.match(runtimeJs, /const chromeGroupTabIds = new Set\(\);/);
  assert.match(runtimeJs, /if \(!group\?\.isChromeGroup\) continue;/);
  assert.match(runtimeJs, /\.filter\(id => !pinnedIds\.has\(id\) && !chromeGroupTabIds\.has\(id\)\)/);
  assert.match(runtimeJs, /if \(!tabIds\.length\) return;\s*beginBatchAction\(\);/);
  assert.match(runtimeJs, /window\.__suppressAutoRefreshUntil = 0;\s*showToast\(runtimeT \? runtimeT\('toastGroupCreateFailed'\)/);
  assert.match(runtimeJs, /if \(typeof muteChromeGroupEvents === 'function'\) muteChromeGroupEvents\(\);/);
  assert.match(runtimeJs, /const groupId = await groupTabsWithStaleRetry\(tabIds\);/);
  assert.match(runtimeJs, /const title = buildBatchMergeGroupTitle\(tabIds\);/);
  assert.match(runtimeJs, /await chrome\.tabGroups\.update\(groupId, \{ title, color \}\)/);
  // Merged groups rotate through the accent palette (starting past grey), so
  // consecutive merges are visibly different colors instead of always grey.
  assert.match(runtimeJs, /let chromeGroupMergeColorIndex = 1;/);
  assert.match(runtimeJs, /runtimeAssignGroupColor\('all', chromeGroupMergeColorIndex\+\+\)/);
  // Tabs leaving dashboard groups drop their manual assignments.
  assert.match(runtimeJs, /clearTabsFromSessionGroups\(sessionGroupsState, tabIds\);/);
  assert.match(runtimeJs, /pruneSessionGroups\(nextState, getOpenTabIdsForSessionPruning\(\)\);/);
  const i18nJs = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8');
  assert.match(i18nJs, /batchMergeChromeGroup: 'Merge into Chrome group'/);
  assert.match(i18nJs, /batchMergeChromeGroup: '合并为 Chrome 标签组'/);
  assert.match(i18nJs, /batchMergeGroupTitle: 'Selected \(\{count\}\)'/);
  assert.match(i18nJs, /batchMergeGroupTitle: '所选标签页 \(\{count\}\)'/);
  assert.match(i18nJs, /toastBatchMergedChromeGroup: 'Merged \{count\} tabs into a Chrome tab group'/);
  assert.match(i18nJs, /toastBatchMergedChromeGroup: '已将 \{count\} 个标签页合并为 Chrome 标签组'/);
});

test('batch merge names the group from the selected tabs content (domain heuristic)', () => {
  // Chrome exposes no content-aware naming API (tabGroups only has
  // create/get/move/query/update; the browser's AI Tab Organizer is UI-only),
  // so the name is derived locally: most frequent domain wins, single-domain
  // selections use the bare site name, mixed selections append the count;
  // unresolvable URLs fall back to the first tab's title.
  assert.match(runtimeJs, /function buildBatchMergeGroupTitle\(tabIds\) \{/);
  assert.match(runtimeJs, /const rawUrl = String\(tab\?\.url \|\| ''\);/);
  assert.match(runtimeJs, /new URL\(rawUrl\)\.hostname/);
  assert.match(runtimeJs, /counts\.size === 1 \? label : `\$\{label\} ×\$\{topCount\}`/);
  assert.match(runtimeJs, /friendlyDomain\(topDomain\)/);
  assert.match(runtimeJs, /tabs\.find\(t => t\?\.title\)\?\.title/);
});

test('batch close never closes a window\'s last tab', () => {
  assert.match(runtimeJs, /async function closeTabsSafely\(tabIds\) \{[\s\S]{0,400}const allTabs = await queryTabsForDashboardWindow\(\);\s*const safeToClose = ensureWindowsKeepLastTab\(allTabs, tabIds\);/);
  assert.match(runtimeJs, /if \(closedCount > 0\) playCloseSound\(\);/);
});

test('finishBatchAction syncs selection UI and always resets the refresh suppression', () => {
  // The batch bar/highlight must update immediately (not only after render),
  // and the suppression window must be closed even if renderDashboard rejects.
  assert.match(runtimeJs, /refreshPageChipSelectionClasses\(\);\s*try \{[\s\S]{0,200}await renderDashboard\(\);\s*updateBackToTopVisibility\(\);\s*\} finally \{\s*window\.__suppressAutoRefreshUntil = 0;\s*\}/);
});

test('persisted group order never stores __chrome_group__ keys', () => {
  const fn = new Function(`${extractFn(runtimeJs, 'buildPersistentGroupOrderReplacingKey')}\nreturn buildPersistentGroupOrderReplacingKey;`)();
  globalThis.domainGroups = [
    { domain: 'github.com' },
    { domain: '__chrome_group__:1' },
    { domain: '__session_group__:abc' },
  ];
  // Replacing a normal key keeps non-chrome keys and inserts the replacement.
  assert.deepEqual(fn('news.ycombinator.com', 'github.com'), ['news.ycombinator.com', '__session_group__:abc']);
  // A chrome replacement key is never persisted into the durable order, and
  // the replaced non-chrome key stays in the order.
  assert.deepEqual(fn('__chrome_group__:2', 'github.com'), ['github.com', '__session_group__:abc']);
  delete globalThis.domainGroups;
});

test('batch sleep distinguishes failed from skipped-active tabs', () => {
  assert.match(runtimeJs, /if \(discarded > 0\) \{[\s\S]{0,300}showToast\(runtimeT \? runtimeT\('toastTabsDiscarded', \{ count: discarded \}\)[\s\S]{0,200}toastTabDiscardFailed[\s\S]{0,300}toastBatchSleepNone/);
  // Batch sleep keeps the selection on every selected chip that is still open,
  // matching the dedup behavior (stale ids are pruned by the re-render). It
  // resolves through the DOM so chip sort ids from every card are preserved.
  assert.match(runtimeJs, /function getPageChipTabIdMap\(\) \{/);
  assert.match(runtimeJs, /const chipTabIds = getPageChipTabIdMap\(\);/);
  assert.match(runtimeJs, /const keptChipIds = \[\];/);
  assert.match(runtimeJs, /keptChipIds\.push\(String\(chipId\)\);/);
  assert.match(runtimeJs, /selectedPageChipIds = new Set\(keptChipIds\);\s*pageChipSelectionAnchorId = '';/);
});

test('sleeping a stale (ghost) chip re-renders instead of silently corrupting grouping', () => {
  // Per-chip sleep detects a tab id that no longer exists in Chrome and
  // re-renders (dropping the ghost row and pruning its dangling assignment).
  assert.match(runtimeJs, /let liveTab = null;\s*try \{ liveTab = await chrome\.tabs\.get\(Number\(tabId\)\); \} catch \{ liveTab = null; \}[\s\S]{0,300}if \(!liveTab\) \{\s*await renderDashboard\(\);\s*updateBackToTopVisibility\(\);\s*window\.__suppressAutoRefreshUntil = 0;\s*showToast\(runtimeT \? runtimeT\('toastTabAlreadyClosed'\)/);
  // Batch sleep uses the SAME live pre-check (the in-memory openTabs snapshot
  // still holds the ghost id, so a snapshot lookup can never classify it) and
  // counts dead ids as stale instead of discarded.
  assert.match(runtimeJs, /let liveTab = null;\s*try \{ liveTab = await chrome\.tabs\.get\(tabId\); \} catch \{ liveTab = null; \}[\s\S]{0,120}if \(!liveTab\) \{ stale \+= 1; continue; \}/);
  assert.match(runtimeJs, /} else if \(stale > 0\) \{\s*showToast\(runtimeT \? runtimeT\('toastTabAlreadyClosed'\) : 'Tab already closed'\);/);
});

test('close-duplicates and merge-group are header icon actions left of the sleep action', () => {
  assert.match(runtimeJs, /const dedupButton = hasDupes \? `\s*<button class="group-action-icon" type="button" data-action="dedup-keep-one" data-dupe-urls="\$\{dupeUrlsEncoded\}" aria-label="\$\{dedupLabel\}" data-tooltip="\$\{dedupLabel\}">/);
  // The merge action is hidden on cards that already ARE a Chrome group.
  assert.match(runtimeJs, /const mergeGroupButton = group\.isChromeGroup \? '' : `\s*<button class="group-action-icon" type="button" data-action="group-card-tabs" data-domain-id="\$\{stableId\}" aria-label="\$\{runtimeT \? runtimeT\('groupCardTabsLabel'\)/);
  // Close-duplicates sits leftmost, then merge, then the sleep icon.
  assert.match(runtimeJs, /<div class="mission-actions">\s*\$\{dedupButton\}\s*\$\{mergeGroupButton\}\s*\$\{sleepControlEnabled \? `/);
  // Chrome group cards carry their native group id and color for the bar.
  assert.match(runtimeJs, /class="mission-card domain-card \$\{hasDupes \? 'has-amber-bar' : 'has-neutral-bar'\}\$\{group\.isChromeGroup \? ' chrome-group-card' : ''\}"[\s\S]{0,200}data-chrome-group-id="\$\{group\.chromeGroupId\}"[\s\S]{0,120}--chrome-group-color:\$\{chromeColor\}/);
});

test('merge/duplicate actions reuse the icon-button style of sleep/save/close', () => {
  const helperJs = fs.readFileSync(path.join(__dirname, 'ui-helpers.js'), 'utf8');
  assert.match(helperJs, /mergeGroup: `<svg[\s\S]*<\/svg>`/);
  assert.match(helperJs, /closeDuplicates: `<svg[\s\S]*<\/svg>`/);
  assert.doesNotMatch(runtimeJs, /data-action="group-card-tabs"[\s\S]{0,120}class="action-btn"/);
});

test('per-chip duplicate count badges are not rendered', () => {
  // The "(Nx)" text badge on duplicated rows is gone; the duplicate detection
  // (card badge, dedup action, border highlight) stays.
  assert.doesNotMatch(runtimeJs, /chip-dupe-badge/);
  assert.doesNotMatch(runtimeJs, /dupeTag/);
  assert.match(runtimeJs, /\$\{count > 1 \? ' chip-has-dupes' : ''\}/);
});

test('the bottom of the tab list keeps the same hairline as the middle rows', () => {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert.match(css, /\.page-chip \{\s*[\s\S]{0,200}border-bottom: 1px solid rgba\(154, 145, 138, 0\.12\);/);
  assert.doesNotMatch(css, /\.page-chip:last-child,[\s\S]*\.page-chip-overflow \{\s*border-bottom: none;/);
});

test('touch/pen synthesized clicks do not double-toggle the row', () => {
  assert.match(runtimeJs, /let pageChipPointerToggleGuard = \{ key: '', until: 0 \};/);
  assert.match(runtimeJs, /pageChipPointerToggleGuard = \{ key: String\(draggedPageChipId \|\| ''\), until: Date\.now\(\) \+ 400 \};/);
  assert.match(runtimeJs, /if \(pageChipPointerToggleGuard\.key === key[\s\S]{0,200}Date\.now\(\) - pageChipLastKeydownAt > 120\) return;/);
  assert.match(runtimeJs, /pageChipLastKeydownAt = Date\.now\(\);/);
});

test('batch drag badge counts only rows that will actually reorder on the source group', () => {
  assert.match(runtimeJs, /inListCount = movingIds\.filter\(id => \[\.\.\.listEl\.children\]\.some\(n => String\(n\.dataset\?\.chipSortId \|\| ''\) === String\(id\)\)\)\.length;/);
});

test('selection clears after cross-group moves and new-group creation', () => {
  assert.match(runtimeJs, /logPageChipDragDebug\('finish-group-move', \{ groupKey: movedGroup\.groupKey, groupName: movedGroup\.groupName \}\);\s*(?:\/\/[^\n]*\n\s*)*clearPageChipSelection\(\);/);
  assert.match(runtimeJs, /logPageChipDragDebug\('finish-new-group', \{ groupName: createdGroup\.name \}\);\s*(?:\/\/[^\n]*\n\s*)*clearPageChipSelection\(\);/);
});

test('expanded overflow rows are full rows: handle, sort id, selection, drag', () => {
  assert.match(runtimeJs, /function buildPageChipHtml\(tab, group, urlCounts = \{\}, collapsed = false\) \{/);
  assert.match(runtimeJs, /data-chip-sort-id="\$\{safeSortId\}" data-chip-group-id="\$\{safeGroupId\}"/);
  assert.match(runtimeJs, /const pageChips = orderedTabs\.map\(\(tab, index\) => buildPageChipHtml\(tab, group, urlCounts, index >= 8 && !isOverflowExpanded\)\)\.join\(''\)/);
  // Overflow rows are direct list children collapsed with a CSS class — not a
  // hidden wrapper that would break drag ordering and selection.
  assert.doesNotMatch(runtimeJs, /page-chips-overflow/);
  assert.match(runtimeJs, /\$\{collapsed \? ' page-chip--collapsed' : ''\}/);
});

test('expanded overflow state survives re-renders (drag commits, refreshes)', () => {
  assert.match(runtimeJs, /let expandedPageChipGroupKeys = new Set\(\);/);
  assert.match(runtimeJs, /const isOverflowExpanded = expandedPageChipGroupKeys\.has\(String\(group\.domain\)\);/);
  assert.match(runtimeJs, /\(extraCount > 0 && !isOverflowExpanded \? buildOverflowChips\(extraCount\) : ''\)/);
  assert.match(runtimeJs, /if \(groupKey\) expandedPageChipGroupKeys\.add\(groupKey\);/);
  assert.match(runtimeJs, /for \(const key of expandedPageChipGroupKeys\) \{[\s\S]{0,200}expandedPageChipGroupKeys\.delete\(key\);/);
});

test('expand action reveals collapsed chips as regular list rows', () => {
  assert.match(runtimeJs, /if \(action === 'expand-chips'\) \{[\s\S]{0,300}const collapsed = cardEl \? \[\.\.\.cardEl\.querySelectorAll\('\.page-chip--collapsed'\)\] : \[\];\s*collapsed\.forEach\(chip => chip\.classList\.remove\('page-chip--collapsed'\)\);/);
});

test('collapsed overflow rows are hidden with CSS only', () => {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert.match(css, /\.page-chip--collapsed \{\s*display: none;/);
});

test('drops at the bottom of a card stay in the visible section (overflow fix)', () => {
  // Collapsed rows must never be placeholder insertion candidates, and a drop
  // below the last visible row parks the placeholder before the collapsed block.
  assert.match(runtimeJs, /\[\.\.\.listEl\.querySelectorAll\('\[data-chip-sort-id\]:not\(\.is-dragging\):not\(\.page-chip--collapsed\)'\)\]/);
  assert.match(runtimeJs, /const firstCollapsed = listEl\.querySelector\('\.page-chip--collapsed'\);\s*if \(firstCollapsed\) listEl\.insertBefore\(placeholder, firstCollapsed\);/);
});

test('same-group commit falls back to a re-render when the placeholder is missing', () => {
  assert.match(runtimeJs, /requiresOpenTabsRebuild = !pageChipPlaceholderEl;/);
});

test('dropping outside any target cancels the drag instead of removing rows', () => {
  assert.match(runtimeJs, /logPageChipDragDebug\('finish-dead-zone-cancel', \{ moved \}\);\s*clearPageChipDragState\(\{ removeNode: false \}\);\s*return true;/);
});

test('range selection only walks visible rows (collapsed rows excluded)', () => {
  assert.match(runtimeJs, /const rows = \[\.\.\.card\.querySelectorAll\('\.page-chip\[data-chip-sort-id\]:not\(\.page-chip--collapsed\)'\)\];/);
});

test('Space on a focused handle keeps the native button activation (no keydown preventDefault)', () => {
  assert.match(runtimeJs, /document\.addEventListener\('keydown', \(e\) => \{\s*pageChipLastKeydownAt = Date\.now\(\);\s*if \(e\.key !== 'Escape'\) return;/);
});

test('keyboard expansion hands focus to the first revealed row', () => {
  assert.match(runtimeJs, /if \(e\.detail === 0\) \{\s*const firstHandle = collapsed\[0\]\?\.querySelector\('\[data-chip-drag-handle="tab"\]'\);\s*if \(firstHandle\) firstHandle\.focus\(\);/);
});
