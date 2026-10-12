export const ACTIONS = ['status', 'tabs', 'open', 'focus', 'close', 'navigate', 'back', 'forward', 'reload', 'snapshot', 'screenshot', 'click', 'hover', 'fill', 'type', 'press', 'scroll', 'select', 'wait', 'detach'];
export const READ_ACTIONS = new Set(['status', 'tabs', 'snapshot', 'screenshot', 'wait']);
const required = {
  open: ['url'], navigate: ['url'], fill: ['ref', 'text'], type: ['text'], press: ['key'], select: ['ref', 'values'], wait: ['milliseconds'],
};
const stringLimits = { url: 8192, ref: 256, text: 50_000, key: 100 };

export function validateAction(input) {
  if (!input || typeof input !== 'object' || !ACTIONS.includes(input.action)) throw new Error('Unknown browser action.');
  const { action, ...params } = input;
  if (!['status', 'tabs', 'open'].includes(action) && (!Number.isSafeInteger(params.tabId) || params.tabId < 0)) {
    throw new Error('This action requires an explicit tabId from tabs. Never guess tab IDs.');
  }
  for (const key of required[action] ?? []) {
    if (params[key] === undefined) throw new Error(`${action} requires ${key}.`);
  }
  for (const [key, max] of Object.entries(stringLimits)) {
    if (params[key] !== undefined && (typeof params[key] !== 'string' || params[key].length > max)) throw new Error(`Invalid ${key} (maximum ${max} characters).`);
  }
  if (params.url !== undefined) {
    let url;
    try { url = new URL(params.url); } catch { throw new Error('Supply an absolute http:// or https:// URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are allowed.');
  }
  const ranges = {
    x: [0, 100_000], y: [0, 100_000], deltaX: [-100_000, 100_000], deltaY: [-100_000, 100_000],
    milliseconds: [0, 5000], maxChars: [100, 20_000], maxElements: [1, 200], clickCount: [1, 2],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const n = params[key];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)) throw new Error(`Invalid ${key}: expected ${min}–${max}.`);
    if (n !== undefined && ['milliseconds', 'maxChars', 'maxElements', 'clickCount'].includes(key) && !Number.isInteger(n)) throw new Error(`${key} must be an integer.`);
  }
  if (['click', 'hover'].includes(action) && !params.ref && !(params.x !== undefined && params.y !== undefined)) throw new Error('Supply a fresh snapshot ref OR screenshot coordinates x and y.');
  if (params.ref && (params.x !== undefined || params.y !== undefined)) throw new Error('Use a ref OR coordinates, not both.');
  if (params.button !== undefined && !['left', 'middle', 'right'].includes(params.button)) throw new Error('Invalid mouse button.');
  if (params.values !== undefined && (!Array.isArray(params.values) || params.values.length > 100 || params.values.some(v => typeof v !== 'string' || v.length > 1000))) throw new Error('values must be an array of at most 100 short strings.');
  return { action, params };
}

// Deliberately omit typed text and URL query strings from the UI approval summary.
export function approvalSummary(action, params) {
  let target = params.tabId === undefined ? 'new tab' : `tab ${params.tabId}`;
  if (params.url) {
    const url = new URL(params.url);
    target += ` → ${url.origin}${url.pathname}`;
  }
  if (params.ref) target += `, ref ${params.ref}`;
  if (params.text !== undefined) target += `, ${params.text.length} characters`;
  if (params.key) target += `, key ${params.key}`;
  return `${action}: ${target}`;
}
