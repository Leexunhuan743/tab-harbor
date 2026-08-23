'use strict';

/**
 * Search-field suggestion logic — pure, testable helpers.
 *
 * This module only builds and filters suggestion rows. Rendering and Chrome
 * API access live in dashboard-runtime.js; everything here is a pure function
 * of its inputs so it can run under `node --test` without a browser.
 */

/* ----------------------------------------------------------------
   Normalization
   ---------------------------------------------------------------- */

function normalizeSuggestionText(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Simple relevance score: 0 = no match, higher = better.
 * Matches title, URL, hostname and label with prefix/word bonuses.
 */
function scoreSuggestion(item, queryTokens) {
  const text = normalizeSuggestionText(item.title || item.label || item.url || '');
  if (!text || !queryTokens.length) return 0;

  let score = 0;
  const haystack = text;
  const urlText = normalizeSuggestionText(item.url || '');

  for (const token of queryTokens) {
    if (!token) continue;
    if (haystack.startsWith(token)) score += 8;
    else if (haystack.includes(token)) score += 4;
    if (urlText.includes(token)) score += 2;
    // Word-boundary bonus: token appears at a word start.
    const wordMatch = new RegExp(`(^|[\\s./:_-])${escapeRegExp(token)}`, 'i');
    if (wordMatch.test(haystack)) score += 3;
    if (!haystack.includes(token) && !urlText.includes(token)) return 0;
  }
  return score;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ----------------------------------------------------------------
   Source builders
   ---------------------------------------------------------------- */

function buildOpenTabSuggestions(tabs = []) {
  const seen = new Set();
  const rows = [];
  for (const tab of tabs) {
    if (!tab || !tab.url) continue;
    if (seen.has(tab.url)) continue;
    seen.add(tab.url);
    rows.push({
      type: 'tab',
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || '',
      tabId: tab.id != null ? tab.id : null,
      windowId: tab.windowId,
    });
  }
  return rows;
}

function buildQuickShortcutSuggestions(shortcuts = []) {
  const seen = new Set();
  const rows = [];
  for (const shortcut of shortcuts || []) {
    if (!shortcut || !shortcut.url) continue;
    if (seen.has(shortcut.url)) continue;
    seen.add(shortcut.url);
    rows.push({
      type: 'shortcut',
      url: shortcut.url,
      title: shortcut.label || shortcut.url,
      label: shortcut.label || '',
      favIconUrl: shortcut.icon || '',
    });
  }
  return rows;
}

function buildSessionTabSuggestions(sessions = []) {
  const seen = new Set();
  const rows = [];
  for (const session of sessions || []) {
    const sessionName = (session && session.name) || '';
    for (const tab of (session && session.tabs) || []) {
      if (!tab || !tab.url) continue;
      if (seen.has(tab.url)) continue;
      seen.add(tab.url);
      rows.push({
        type: 'session',
        url: tab.url,
        title: tab.title || tab.url,
        label: sessionName,
        favIconUrl: tab.favIconUrl || '',
      });
    }
  }
  return rows;
}

function buildHistorySuggestions(historyItems = []) {
  const seen = new Set();
  const rows = [];
  for (const item of historyItems || []) {
    if (!item || !item.url) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    rows.push({
      type: 'history',
      url: item.url,
      title: item.title || item.url,
      favIconUrl: '',
      visitCount: item.visitCount || 0,
      lastVisitTime: item.lastVisitTime || 0,
    });
  }
  return rows;
}

/* ----------------------------------------------------------------
   Query filtering
   ---------------------------------------------------------------- */

const SUGGESTION_SOURCE_ORDER = ['tab', 'shortcut', 'session', 'history'];

function filterSuggestions(rows = [], query = '') {
  const q = normalizeSuggestionText(query);
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  if (!tokens.length) return rows.slice(0, 12);

  const scored = rows
    .map(item => ({ item, score: scoreSuggestion(item, tokens) }))
    .filter(entry => entry.score > 0);
  scored.sort((a, b) => {
    // Same source → score desc; different sources keep stable source order.
    if (a.item.type !== b.item.type) {
      return SUGGESTION_SOURCE_ORDER.indexOf(a.item.type) - SUGGESTION_SOURCE_ORDER.indexOf(b.item.type);
    }
    return b.score - a.score;
  });
  return scored.slice(0, 12).map(entry => entry.item);
}

/* ----------------------------------------------------------------
   Assembly
   ---------------------------------------------------------------- */

function assembleSuggestions({ tabs = [], shortcuts = [], sessions = [], history = [] }, query = '') {
  const all = [
    ...buildOpenTabSuggestions(tabs),
    ...buildQuickShortcutSuggestions(shortcuts),
    ...buildSessionTabSuggestions(sessions),
    ...buildHistorySuggestions(history),
  ];
  return filterSuggestions(all, query);
}

/* ----------------------------------------------------------------
   Test exposure
   ---------------------------------------------------------------- */

globalThis.TabHarborSearchSuggestions = {
  assembleSuggestions,
  buildHistorySuggestions,
  buildOpenTabSuggestions,
  buildQuickShortcutSuggestions,
  buildSessionTabSuggestions,
  filterSuggestions,
  scoreSuggestion,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    assembleSuggestions,
    buildHistorySuggestions,
    buildOpenTabSuggestions,
    buildQuickShortcutSuggestions,
    buildSessionTabSuggestions,
    filterSuggestions,
    scoreSuggestion,
  };
}
