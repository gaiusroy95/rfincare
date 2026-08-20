async function fetchWithTimeout(url, options = {}, timeoutMs = 15e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error(
        options.timeoutMessage || `Request timed out after ${Math.round(timeoutMs / 1e3)}s`
      );
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
function withPromiseTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(message || `Operation timed out after ${Math.round(timeoutMs / 1e3)}s`);
      err.status = 504;
      reject(err);
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
export {
  fetchWithTimeout,
  withPromiseTimeout
};
