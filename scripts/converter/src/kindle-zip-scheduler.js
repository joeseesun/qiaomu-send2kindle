// Modern worker timers only; no legacy DOM/script scheduling in the bundle.
function schedule(callback, ...args) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback');
  return globalThis.setTimeout(callback, 0, ...args);
}
if (typeof globalThis.setImmediate !== 'function') {
  globalThis.setImmediate = schedule;
  globalThis.clearImmediate = id => globalThis.clearTimeout(id);
}
export default schedule;
