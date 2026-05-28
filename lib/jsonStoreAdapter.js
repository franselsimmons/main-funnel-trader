// lib/jsonStoreAdapter.js
// Adapter zodat microFamilyOutcomeStore niet afhankelijk is van jouw exacte KV/store implementatie.

export function createJsonStoreAdapter(store) {
  if (!store) {
    throw new Error('createJsonStoreAdapter requires store');
  }

  return {
    async getJson(key) {
      if (typeof store.getJson === 'function') {
        return store.getJson(key);
      }

      if (typeof store.get === 'function') {
        const value = await store.get(key);

        if (value == null) return null;
        if (typeof value === 'string') return JSON.parse(value);

        return value;
      }

      if (typeof store.read === 'function') {
        const value = await store.read(key);

        if (value == null) return null;
        if (typeof value === 'string') return JSON.parse(value);

        return value;
      }

      throw new Error('Store adapter needs getJson(key), get(key), or read(key)');
    },

    async setJson(key, value) {
      if (typeof store.setJson === 'function') {
        return store.setJson(key, value);
      }

      if (typeof store.set === 'function') {
        return store.set(key, JSON.stringify(value));
      }

      if (typeof store.write === 'function') {
        return store.write(key, JSON.stringify(value));
      }

      throw new Error('Store adapter needs setJson(key, value), set(key, value), or write(key, value)');
    },

    async deleteKey(key) {
      if (typeof store.deleteKey === 'function') {
        return store.deleteKey(key);
      }

      if (typeof store.del === 'function') {
        return store.del(key);
      }

      if (typeof store.delete === 'function') {
        return store.delete(key);
      }

      if (typeof store.remove === 'function') {
        return store.remove(key);
      }

      return false;
    },
  };
}