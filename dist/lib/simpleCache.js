const store = /* @__PURE__ */ new Map();
function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}
function cacheSet(key, value, ttlMs = 12e4) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}
function cacheDeletePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
function cacheClear() {
  store.clear();
}
export {
  cacheClear,
  cacheDeletePrefix,
  cacheGet,
  cacheSet
};
