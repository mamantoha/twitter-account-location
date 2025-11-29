// CacheManager class for handling IndexedDB operations
class CacheManager {
  constructor() {
    this.DB_NAME = "TwitterLocationCache";
    this.DB_VERSION = 1;
    this.STORE_NAME = "locations";
    this.CACHE_EXPIRY_DAYS = 30;
  }

  // Open IndexedDB database
  async openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME);
        }
      };
    });
  }

  // Get a single cached value from IndexedDB
  async getValue(username) {
    try {
      const db = await this.openDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.get(username);

      return new Promise((resolve, reject) => {
        request.onsuccess = async (event) => {
          const data = event.target.result;
          const now = Date.now();
          const expiryMs = this.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
          if (data && data.cachedAt + expiryMs > now) {
            db.close();
            resolve(data);
          } else {
            // Expired or no data, delete if exists
            if (data) {
              await this.deleteEntry(username);
            }
            db.close();
            resolve(undefined);
          }
        };
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
      });
    } catch (error) {
      console.error("Error getting cached value:", error);
      return undefined;
    }
  }

  // Get total count of cached locations
  async getCacheCount() {
    try {
      const db = await this.openDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.count();

      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          db.close();
          resolve(request.result);
        };
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
      });
    } catch (error) {
      console.error("Error getting cache count:", error);
      return 0;
    }
  }

  // Save a cache entry to IndexedDB
  async saveCacheEntry(username, account) {
    if (!browser.runtime?.id) {
      return;
    }

    // Save to IndexedDB immediately
    try {
      const db = await this.openDB();
      const transaction = db.transaction([this.STORE_NAME], "readwrite");
      const store = transaction.objectStore(this.STORE_NAME);

      const now = Date.now();
      const data = {
        account: account,
        cachedAt: now,
      };
      const request = store.put(data, username);
      await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      db.close();
    } catch (error) {
      console.error("Error saving cache entry:", error);
    }
  }

  // Delete an expired cache entry from IndexedDB
  async deleteEntry(username) {
    try {
      const db = await this.openDB();
      const transaction = db.transaction([this.STORE_NAME], "readwrite");
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.delete(username);
      await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      db.close();
    } catch (error) {
      console.error("Error deleting expired cache entry:", error);
    }
  }

  // Load cache from persistent storage (no-op since we don't need to preload anything now)
  async loadCache() {
    // Previously loaded final markers, but now we don't need to preload anything
  }
}

// Create a global instance
const cacheManager = new CacheManager();
