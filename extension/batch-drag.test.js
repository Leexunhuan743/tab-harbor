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

test('pointerup parks the placeholder at the release point (fast-flick fix)', () => {
  assert.match(runtimeJs, /if \(!stickyIsNonSource\) \{\s*(?:\/\/[^\n]*\n\s*)*previewPageChipOrder\(e\.clientX, e\.clientY\);/);
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

test('batch actions close, sleep and save the whole selection', () => {
  assert.match(runtimeJs, /data-action="batch-close-tabs"/);
  assert.match(runtimeJs, /data-action="batch-discard-tabs"/);
  assert.match(runtimeJs, /data-action="batch-save-session"/);
  assert.match(runtimeJs, /data-action="clear-chip-selection"/);
  assert.match(runtimeJs, /openTabSessionPicker\(\{\s*source: 'selected',\s*initialTabIds: tabIds,\s*scopeTabIds: tabIds,\s*\}\)/);
});

test('batch close never closes a window\'s last tab', () => {
  assert.match(runtimeJs, /if \(action === 'batch-close-tabs'\) \{[\s\S]{0,600}const allTabs = await queryTabsForDashboardWindow\(\);\s*const toClose = ensureWindowsKeepLastTab\(allTabs, tabIds\);/);
  assert.match(runtimeJs, /if \(closedCount > 0\) playCloseSound\(\);/);
});

test('batch sleep distinguishes failed from skipped-active tabs', () => {
  assert.match(runtimeJs, /if \(discarded > 0\) \{[\s\S]{0,300}showToast\(runtimeT \? runtimeT\('toastTabsDiscarded', \{ count: discarded \}\)[\s\S]{0,200}toastTabDiscardFailed[\s\S]{0,300}toastBatchSleepNone/);
});

test('sleeping a stale (ghost) chip re-renders instead of silently corrupting grouping', () => {
  // Per-chip sleep detects a tab id that no longer exists in Chrome and
  // re-renders (dropping the ghost row and pruning its dangling assignment).
  assert.match(runtimeJs, /let liveTab = null;\s*try \{ liveTab = await chrome\.tabs\.get\(Number\(tabId\)\); \} catch \{ liveTab = null; \}[\s\S]{0,300}if \(!liveTab\) \{\s*await renderDashboard\(\);\s*updateBackToTopVisibility\(\);\s*window\.__suppressAutoRefreshUntil = 0;\s*showToast\(runtimeT \? runtimeT\('toastTabAlreadyClosed'\)/);
  // Batch sleep skips ghost ids instead of counting them as discarded.
  assert.match(runtimeJs, /if \(!tab\) \{ stale \+= 1; continue; \}/);
  assert.match(runtimeJs, /} else if \(stale > 0\) \{\s*showToast\(runtimeT \? runtimeT\('toastTabAlreadyClosed'\) : 'Tab already closed'\);/);
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
