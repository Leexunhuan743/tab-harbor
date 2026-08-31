# Decision: Search-field auto-focus and inline suggestions

> Status: Current — shipped and converged.
> Class: Feature.
> Owner: `extension/index.html` search header (`headerSearchForm`), `extension/dashboard-runtime.js`, `extension/search-suggestions.js`, `extension/manifest.json`.
> Supersedes: none (new capability).

## Problem

Opening a new Tab Harbor tab left the cursor nowhere: a user who wanted to
search had to click into the search field first. And once focused, the field
offered no inline suggestions, so there was no fast path from "type a few
letters" to "re-open a tab / visit a known page / run the search" without
either navigating manually or using the browser's own omnibox.

The problem is independent of the solution: the dashboard's built-in search
should be reachable in one keystroke and should help the user pick a
destination, not just submit a bare query.

## Decision

Two additions to the existing header search:

1. **Auto-focus**: whenever the Tab Harbor dashboard page becomes the active
   (foreground) tab — initial load and return to the tab — keyboard focus moves
   to `#headerSearchInput`, unless the user is already typing in another form
   field or contenteditable on the page. `shouldAutoFocusSearchField()` owns
   the decision; `focusSearchFieldOnForeground()` applies it from
   `initializeDashboardRuntime`, the window `focus` listener, and the
   `visibilitychange` listener. Because Chrome focuses the omnibox shortly
   after a newtab page finishes loading (which can override the initial
   focus), `scheduleSearchFocusVerification()` retries on a short delay
   schedule (`120/350/800/1500ms`) until the input actually holds focus.

2. **Inline suggestion panel** under the search shell (`#headerSearchSuggestions`),
   populated from the union (de-duplicated by URL) of:
   - open tabs in the current window (`type: 'tab'`);
   - quick shortcuts (`type: 'shortcut'`);
   - saved session tabs (`type: 'session'`);
   - browser history (`type: 'history'`, requires the `history` permission).

   Behavior:
   - The panel appears only while the query is non-empty: focusing the field
     shows nothing, typing filters all sources client-side, and clearing the
     field hides the panel. (A user-review finding: the first iteration showed
     a default panel on focus; the panel now stays quiet until input.)
   - `ArrowUp`/`ArrowDown` move the selection; `Enter` activates it; `Escape`
     closes the panel and returns focus to the input.
   - An open-tab row activates that tab in its window on click or Enter;
     Ctrl/Cmd+click or Ctrl/Cmd+Enter opens the same URL in a new tab.
   - Shortcut / session / history rows open their URL in a new tab
     (`openOrFocusUrl`); Ctrl/Cmd still forces the new-tab path.
   - Clicking outside the form closes the panel; submitting the form closes it
     before running the search.
   - History is read on demand while the user is typing (empty-text
     `chrome.history.search`, bounded to 20 items, cached 30s) and is never
     stored, exported, or sent anywhere by Tab Harbor.

Implementation split: pure logic lives in `extension/search-suggestions.js`
(builders, de-dup, scoring, filtering — unit-testable under `node --test`);
runtime wiring lives in `dashboard-runtime.js` (`setupSearchSuggestions`,
`refreshSearchSuggestions`, `renderSearchSuggestions`,
`activateSearchSuggestion`, focus helpers) so it can reuse `getRealTabs`,
`focusTab`/`openOrFocusUrl`, the favicon pipeline, and the existing
`renderDashboard` refresh hook.

## Alternatives considered

1. **Fake omnibox (typed URL → navigate)**: richer, but changes the search box
   contract from "search" to "navigate-or-search", needs URL-vs-query
   disambiguation, and broadens the field's surface beyond the calm
   one-job-per-control design. Rejected; the submit path still routes through
   `chrome.search.query` when the engine is default.
2. **Suggest only workspace data, no history**: zero new permissions, smallest
   change. Rejected: the user explicitly asked for history ("两者都要") and
   accepted the `history` permission trade-off.
3. **Suggest only on initial load, not on re-focus**: less intrusive. Rejected:
   the user explicitly chose "每次页面回到前台都聚焦".
4. **Native `<datalist>`**: zero JS, but cannot render rich rows (favicons,
   section labels, keyboard hints) and styling is browser-dependent. Rejected:
   the visual and interaction contract belongs to the extension.

## Consequences

- **New permission `history`** in both `manifest.json` files, disclosed in
  `PRIVACY.md` and `privacy.html`. History is read only while the panel is
  open, bounded, and never persisted.
- **Focus may be moved to the search field** whenever the tab returns to the
  foreground. Users who want to click elsewhere on the page first get focus in
  the search field; this is the accepted trade-off of the requested
  always-focus behavior. Other form fields are never robbed of focus.
- **The field is not an address bar**: typed URLs still search instead of
  navigating. Surrendered capability kept for calm one-job scope.
- **New script `search-suggestions.js`** inserted into the dashboard load order
  between `tab-url-utils.js` and `tab-sessions.js`; `index.html` script order
  is part of the runtime contract and must keep this position.
- **CSP**: suggestion favicons reuse the existing `_favicon/` pipeline and
  inline-error-free `setupSearchSuggestionImageFallbacks`; no inline handlers.

## Requirement revisions (user review findings)

| Item | Previous accepted state | New accepted state | Disposition |
|---|---|---|---|
| Panel on focus | Focusing the field showed a default panel (recent history + workspace) | Focusing shows nothing; suggestions appear only while the query is non-empty; clearing the field hides the panel | **Revised** (user: "默认是没有的，只有当我输入一些东西的时候，才会出现悬浮内容") |
| New-tab auto-focus (initial) | Single `focus()` at init; could be overridden by Chrome's omnibox focus after newtab load | `focusSearchFieldOnForeground()` + `scheduleSearchFocusVerification()` retries until the input holds focus | **Revised** (user: "光标并没有自动进入搜索框") |
| New-tab auto-focus (Ctrl+T) | Delayed retries (`120/350/800/1500ms`) after `window load` | Chrome's documented behavior: a freshly created tab always gives the omnibox focus first, and retries alone cannot reliably steal it. `focus-redirect.js` (first script in `<head>`) forces one self-navigation to `?focus=1` on the very first load, turning the new tab into a navigated page; the search input's `autofocus` plus the existing retry loop then claim focus. Retry window widened to `150/400/900/1800/3200/5000ms`; `cancelSearchFocusRetryIfInteracting()` stops retrying once the user interacts with the page. Blank-tab matching (`isNewTabBlank` / `isTabHarborNewTabUrl`) strips the `?focus=1` query so duplicate-new-tab cleanup still recognizes the page | **Revised** (user: "Ctrl+T 新建标签页的时候，光标还是在上方的地址栏那里") |
| Auto-close duplicate new tabs | `closeDuplicateNewTabs()` ran only on `tabs.onCreated`; a Ctrl+T'd duplicate inside the 5s grace window was exempt and never re-checked | Runs on `tabs.onCreated`, on `tabs.onUpdated` when a tab commits a new-tab URL, and once more after the grace period lapses (`scheduleGraceExpiryCheck`); `onRemoved` clears bookkeeping. Re-entrancy guard coalesces concurrent checks. **Immediate close**: a tab whose URL is already an explicit new-tab page (`chrome://newtab/` or the Tab Harbor page) is never grace-exempt, so a Ctrl+T'd duplicate closes right away; the grace exemption now applies only to tabs with empty/uncommitted URLs (session-restore bursts still protected) | **Revised** (user: "设置里面设置会自动关闭重复的新标签页，这个功能失效了"; follow-up: "5 秒之后才能关闭，我觉得时间有点太长了，能不能和之前一样立刻关闭") |
| Search-submit latency | Search ran only from the form `submit` listener: `preventDefault` → `runDefaultSearch` → chrome.* call. Any pending suggestion refresh or focus-retry timer could share the extension page's chrome.* API queue with the navigation | Enter on the input starts the navigation directly from the `keydown` handler (one event-loop turn earlier); `searchSubmitInFlight` prevents the submit listener from double-running; `cancelSearchFocusRetryIfInteracting()` stops the focus-retry loop before navigating; `navigateCurrentTabToUrl` reuses the cached dashboard tab id (skips a `chrome.tabs.query` round-trip); a suggestion-refresh generation counter discards stale in-flight refresh results so their chrome.* calls never contend with the navigation; shortcut + session sources load in parallel | **Revised** (user: "按回车搜索之后，它会延迟1秒之后才会跳转入搜索页面，这个可以加快吗"; follow-up: "是否还可以再加快一点速度呢") |
| IME Enter must not search | Enter always submitted the search | Enter during an input-method composition (`compositionstart`/`compositionend` tracked, plus `e.isComposing`) is blocked from submitting — it confirms the IME candidate instead; the search only runs on a real Enter outside composition | **Revised** (user: "输入法在某个地方输入……按回车确定选中的文字，但是输入框自动给我启动了搜索") |

All findings were behavior corrections to the same iteration and were folded
into this decision (living revision, no replacement record). Note: the residual
~1s on default-engine search is believed to be Chrome's own new-tab-override
navigation teardown (unverifiable headlessly: Chrome 130+ requires a manual
extension enable for `chrome_url_overrides` under `--load-extension`); the
JS-layer sources of added latency are what this revision removes.

## Verification

- `node --test extension/*.test.js` — 449 pass / 0 fail, including:
  - `search-suggestions.test.js`: pure builders, de-dup, scoring, filtering,
    source ordering, caps (10 tests);
  - `search-focus.test.js`: `shouldAutoFocusSearchField` decision matrix
    (6 tests, extracted from the real runtime source);
  - `search-activate.test.js`: `activateSearchSuggestion` chrome call sequence
    for tab-switch, Ctrl-new-tab, history-open, and stale-tab fallback
    (4 tests, extracted from the real runtime source);
  - `focus-redirect.test.js`: redirect behavior (skip when `?focus=1` present,
    replace otherwise) (3 tests);
  - `background.test.js`: `isNewTabBlank` recognizes `?focus=1` URLs; grace
    expiry re-check, `onRemoved` cleanup, and `onUpdated` URL-driven re-check
    (3 new tests);
  - `ui-regression.test.js`: source-contract assertions for the panel DOM,
    script order, `history` permission, focus wiring, redirect script
    placement, `autofocus`, and blank-tab URL normalization.
- 23-script ordered load smoke test (vm sandbox) passes with no top-level
  errors.
- Manual browser verification of the full interaction (auto-focus on Ctrl+T,
  panel keyboard nav, Ctrl/Cmd modifiers, duplicate-tab auto-close, history
  permission prompt) remains a required real-session check before release —
  not automated here.

## Deferred

- History suggestion ranking beyond recency (e.g. visit-count weighting) and a
  settings toggle to disable the history source were considered but left out;
  the feature ships with the union ordering in
  `search-suggestions.js` (`SUGGESTION_SOURCE_ORDER` + score).
