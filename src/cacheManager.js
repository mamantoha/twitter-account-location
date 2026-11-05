// Polyfill: use chrome if browser is undefined (for Chrome compatibility)
/* exported cacheManager */
if (typeof browser === "undefined") {
  var browser = chrome;
}
// CacheManager class for handling IndexedDB operations
class CacheManager {
  constructor() {
    this.DB_NAME = "TwitterLocationCache";
    this.DB_VERSION = 1;
    this.STORE_NAME = "locations";
    this.CACHE_EXPIRY_DAYS = 30;
    this.MISSING_EXPIRY_DAYS = 1;
  }

  getAccountStatus(account) {
    if (!account || (account.errors && (!Array.isArray(account.errors) || account.errors.length > 0))) {
      return null;
    }
    const user = account.data?.user_result_by_screen_name;
    if (!user || !Object.prototype.hasOwnProperty.call(user, "result")) return null;
    if (user.result === null) return "missing";
    const result = user.result;
    if (result && typeof result === "object" &&
        (typeof result.core?.screen_name === "string" ||
         (result.about_profile && typeof result.about_profile === "object"))) {
      return "found";
    }
    return null;
  }

  isValidEntry(entry, now = Date.now()) {
    const status = this.getAccountStatus(entry?.account);
    if (!status || !Number.isFinite(entry.cachedAt)) return false;
    const days = status === "missing" ? this.MISSING_EXPIRY_DAYS : this.CACHE_EXPIRY_DAYS;
    return entry.cachedAt + days * 24 * 60 * 60 * 1000 > now;
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
    let db;
    try {
      db = await this.openDB();
      const transaction = db.transaction([this.STORE_NAME], "readonly");
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.get(username);
      const data = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error || new Error("Cache read aborted"));
      });
      if (this.isValidEntry(data)) return data;
      if (data) await this.deleteEntry(username);
      return undefined;
    } catch (error) {
      console.error("Error getting cached value:", error);
      return undefined;
    } finally {
      if (db) db.close();
    }
  }

  // Filter and optionally prune entries in the same transaction.
  async getAllEntries({ pruneExpired = true } = {}) {
    let db;
    try {
      db = await this.openDB();
      const transaction = db.transaction([this.STORE_NAME], pruneExpired ? "readwrite" : "readonly");
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.openCursor();

      return await new Promise((resolve, reject) => {
        const results = [];
        const now = Date.now();
        transaction.oncomplete = () => resolve(results);
        transaction.onerror = () => reject(transaction.error || new Error("Cache scan failed"));
        transaction.onabort = () => reject(transaction.error || new Error("Cache scan aborted"));
        request.onerror = () => reject(request.error);

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;

          const username = cursor.key;
          const value = cursor.value;
          if (this.isValidEntry(value, now)) {
            results.push({ username, account: value.account, cachedAt: value.cachedAt });
          } else if (pruneExpired) {
            cursor.delete();
          }
          cursor.continue();
        };
      });
    } catch (error) {
      console.error("Error getting all cache entries:", error);
      throw error;
    } finally {
      if (db) db.close();
    }
  }

  // A successful request can still be rolled back before the transaction commits.
  async runWriteTransaction(write) {
    const db = await this.openDB();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction([this.STORE_NAME], "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Cache write failed"));
        transaction.onabort = () => reject(transaction.error || new Error("Cache write aborted"));
        write(transaction.objectStore(this.STORE_NAME));
      });
    } finally {
      db.close();
    }
  }

  // Save a cache entry to IndexedDB
  async saveCacheEntry(username, account) {
    if (!browser.runtime?.id || !this.getAccountStatus(account)) {
      return;
    }
    await this.runWriteTransaction((store) => {
      store.put({ account: account, cachedAt: Date.now() }, username);
    });
  }

  // Delete a cache entry from IndexedDB
  async deleteEntry(username) {
    await this.runWriteTransaction((store) => {
      store.delete(username);
    });
  }
}

// Create a global instance
/* eslint-disable no-unused-vars */
const cacheManager = new CacheManager();
/* eslint-enable no-unused-vars */
