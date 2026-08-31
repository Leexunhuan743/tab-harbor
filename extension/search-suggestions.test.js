'use strict';

// Behavioral tests for the search-suggestion pure logic (extension/search-suggestions.js).
// These execute the real module under node --test, mirroring batch-drag.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  assembleSuggestions,
  buildHistorySuggestions,
  buildOpenTabSuggestions,
  buildQuickShortcutSuggestions,
  buildSessionTabSuggestions,
  filterSuggestions,
  scoreSuggestion,
} = require(path.join(__dirname, 'search-suggestions.js'));

test('buildOpenTabSuggestions dedupes by URL and keeps tab ids', () => {
  const rows = buildOpenTabSuggestions([
    { url: 'https://a.example/', title: 'A', id: 1, windowId: 2 },
    { url: 'https://a.example/', title: 'A dup', id: 3, windowId: 2 },
    { url: 'https://b.example/', title: 'B', id: 4, windowId: 2 },
    { url: '', title: 'no url', id: 5 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'tab');
  assert.equal(rows[0].tabId, 1);
  assert.equal(rows[1].url, 'https://b.example/');
});

test('buildQuickShortcutSuggestions labels rows with the shortcut label', () => {
  const rows = buildQuickShortcutSuggestions([
    { url: 'https://x.example/', label: 'X' },
    { url: 'https://y.example/', label: '' },
  ]);
  assert.equal(rows[0].type, 'shortcut');
  assert.equal(rows[0].title, 'X');
  assert.equal(rows[1].title, 'https://y.example/');
});

test('buildSessionTabSuggestions flattens sessions and dedupes URLs', () => {
  const rows = buildSessionTabSuggestions([
    {
      name: 'Work',
      tabs: [
        { url: 'https://s1.example/', title: 'S1' },
        { url: 'https://s1.example/', title: 'S1 dup' },
        { url: 'https://s2.example/', title: 'S2' },
      ],
    },
    { name: 'Other', tabs: [] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'session');
  assert.equal(rows[0].label, 'Work');
});

test('buildHistorySuggestions normalizes history items', () => {
  const rows = buildHistorySuggestions([
    { url: 'https://h.example/', title: 'H', visitCount: 5, lastVisitTime: 100 },
    { url: 'https://h.example/', title: 'H dup' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'history');
  assert.equal(rows[0].visitCount, 5);
});

test('scoreSuggestion prefers title prefix over loose URL match', () => {
  const titleMatch = scoreSuggestion(
    { title: 'React Docs', url: 'https://react.dev/' },
    ['react']
  );
  const urlOnly = scoreSuggestion(
    { title: 'Something Else', url: 'https://react.dev/' },
    ['react']
  );
  assert.ok(titleMatch > urlOnly, 'title match should outrank URL-only match');
  assert.ok(titleMatch > 0);
});

test('scoreSuggestion returns 0 when no token matches', () => {
  assert.equal(scoreSuggestion({ title: 'Apple', url: 'https://apple.com/' }, ['banana']), 0);
});

test('filterSuggestions returns everything when query is empty, capped at 12', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    type: 'history',
    url: `https://site${i}.example/`,
    title: `Site ${i}`,
  }));
  const filtered = filterSuggestions(rows, '');
  assert.equal(filtered.length, 12);
});

test('filterSuggestions groups by source order: tabs, shortcuts, sessions, history', () => {
  const rows = [
    { type: 'history', url: 'https://h.example/', title: 'H site' },
    { type: 'tab', url: 'https://t.example/', title: 'T site' },
    { type: 'shortcut', url: 'https://s.example/', title: 'S site' },
    { type: 'session', url: 'https://se.example/', title: 'SE site' },
  ];
  const filtered = filterSuggestions(rows, 'site');
  assert.deepEqual(filtered.map(r => r.type), ['tab', 'shortcut', 'session', 'history']);
});

test('assembleSuggestions unions all sources and filters by query', () => {
  const out = assembleSuggestions(
    {
      tabs: [{ url: 'https://t.example/', title: 'Open Tab', id: 1 }],
      shortcuts: [{ url: 'https://s.example/', title: 'Quick Link' }],
      sessions: [{ name: 'Sess', tabs: [{ url: 'https://se.example/', title: 'Saved Page' }] }],
      history: [{ url: 'https://h.example/', title: 'Old Page' }],
    },
    'example'
  );
  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map(r => r.type).sort(),
    ['history', 'session', 'shortcut', 'tab']
  );
});

test('assembleSuggestions filters out non-matching sources', () => {
  const out = assembleSuggestions(
    {
      tabs: [{ url: 'https://t.example/', title: 'Open Tab', id: 1 }],
      shortcuts: [{ url: 'https://s.example/', title: 'Quick Link' }],
      sessions: [{ name: 'Sess', tabs: [{ url: 'https://se.example/', title: 'Saved Page' }] }],
      history: [{ url: 'https://h.example/', title: 'Old Page' }],
    },
    'saved'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'session');
});
