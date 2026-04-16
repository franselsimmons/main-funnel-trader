let latestScan = null;

export function setLatestScan(payload) {
  latestScan = {
    ...payload,
    storedAt: Date.now()
  };
}

export function getLatestScan() {
  return latestScan;
}