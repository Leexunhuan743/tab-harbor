'use strict';

// Focus-decision logic smoke checks against the REAL dashboard-runtime.js.
// shouldAutoFocusSearchField is a pure function of document.activeElement, so
// it can be extracted and executed under node --test without a browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimeJs = fs.readFileSync(path.join(__dirname, 'dashboard-runtime.js'), 'utf8');

function extractFn(source, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  const closeParen = source.indexOf(')', m.index);
  let i = source.indexOf('{', closeParen);
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

const doc = { activeElement: null };
const fn = new Function('document', `${extractFn(runtimeJs, 'shouldAutoFocusSearchField')}\nreturn shouldAutoFocusSearchField;`)(doc);

test('shouldAutoFocusSearchField: no active element → focus', () => {
  doc.activeElement = null;
  assert.equal(fn(), true);
});

test('shouldAutoFocusSearchField: search input focused → no re-focus', () => {
  doc.activeElement = { id: 'headerSearchInput', tagName: 'INPUT' };
  assert.equal(fn(), false);
});

test('shouldAutoFocusSearchField: another input focused → do not steal', () => {
  doc.activeElement = { id: 'todoSearchInput', tagName: 'INPUT' };
  assert.equal(fn(), false);
});

test('shouldAutoFocusSearchField: textarea focused → do not steal', () => {
  doc.activeElement = { tagName: 'TEXTAREA' };
  assert.equal(fn(), false);
});

test('shouldAutoFocusSearchField: button focused → focus search', () => {
  doc.activeElement = { tagName: 'BUTTON' };
  assert.equal(fn(), true);
});

test('shouldAutoFocusSearchField: contenteditable → do not steal', () => {
  doc.activeElement = { tagName: 'DIV', isContentEditable: true };
  assert.equal(fn(), false);
});
