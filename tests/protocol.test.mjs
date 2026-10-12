import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAction, approvalSummary, READ_ACTIONS } from '../src/protocol.mjs';

test('requires explicit tab id and rejects unknown actions', () => {
  for (const action of ['click', 'type', 'snapshot', 'screenshot', 'navigate', 'close']) {
    assert.throws(() => validateAction({ action }), /tabId/);
  }
  assert.throws(() => validateAction({ action: 'evaluate', script: 'alert(1)' }), /Unknown/);
  assert.deepEqual(validateAction({ action: 'tabs' }), { action: 'tabs', params: {} });
});

test('limits navigation schemes and blocks embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'https://user:secret@example.com', 'data:text/html,hi']) {
    assert.throws(() => validateAction({ action: 'open', url }), /HTTP/);
  }
  assert.equal(validateAction({ action: 'open', url: 'https://example.com' }).params.url, 'https://example.com');
});

test('click and hover require unambiguous fresh ref or coordinates', () => {
  assert.throws(() => validateAction({ action: 'click', tabId: 1 }), /ref OR/);
  assert.throws(() => validateAction({ action: 'click', tabId: 1, x: NaN, y: 1 }), /Invalid x/);
  assert.throws(() => validateAction({ action: 'hover', tabId: 1, ref: 'r1', x: 1, y: 1 }), /not both/);
  assert.equal(validateAction({ action: 'click', tabId: 1, x: 0, y: 0 }).action, 'click');
});

test('bounds payloads and waits', () => {
  assert.throws(() => validateAction({ action: 'fill', tabId: 1, ref: 'r1' }), /requires text/);
  assert.throws(() => validateAction({ action: 'fill', tabId: 1, ref: 'r1', text: 'a'.repeat(50_001) }), /Invalid text/);
  assert.throws(() => validateAction({ action: 'wait', tabId: 1, milliseconds: 5001 }), /Invalid milliseconds/);
  assert.throws(() => validateAction({ action: 'select', tabId: 1, ref: 'r1', values: [1] }), /array/);
  assert.throws(() => validateAction({ action: 'snapshot', tabId: 1, maxElements: 2.5 }), /integer/);
});

test('approval summary does not echo typed secrets or query strings', () => {
  assert.equal(approvalSummary('fill', { tabId: 2, ref: 'r3', text: 'secret' }), 'fill: tab 2, ref r3, 6 characters');
  assert.equal(approvalSummary('open', { url: 'https://example.com/path?token=secret#secret' }), 'open: new tab → https://example.com/path');
  for (const action of ['open', 'click', 'type', 'press', 'fill', 'select', 'close', 'navigate']) assert.equal(READ_ACTIONS.has(action), false);
});
