'use strict';

// Behavioral tests for the new-tab focus redirect (extension/focus-redirect.js).
// The script must: (1) do nothing when ?focus=1 is already present (the
// post-redirect load), and (2) replace the location with ?focus=1 otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, 'focus-redirect.js'), 'utf8');

function runRedirect({ search = '', pathname = '/index.html', hash = '' }) {
  let replacedWith = null;
  const location = {
    search,
    pathname,
    hash,
    replace(target) {
      replacedWith = target;
    },
  };
  const fn = new Function('location', code);
  fn(location);
  return replacedWith;
}

test('focus-redirect: no query → replaces with ?focus=1 (keeps hash)', () => {
  const target = runRedirect({ search: '', pathname: '/index.html', hash: '#x' });
  assert.equal(target, '/index.html?focus=1#x');
});

test('focus-redirect: ?focus=1 already present → does nothing', () => {
  const target = runRedirect({ search: '?focus=1', pathname: '/index.html', hash: '' });
  assert.equal(target, null);
});

test('focus-redirect: ?focus=1 with other params → does nothing', () => {
  const target = runRedirect({ search: '?a=1&focus=1', pathname: '/index.html', hash: '' });
  assert.equal(target, null);
});
