import {
  deleteDb,
  loadDbIdentity,
  setIndexedDb,
  setUserAgent,
} from "discourse/plugins/discourse-encrypt/lib/database";
import { test } from "qunit";
import { Promise } from "rsvp";

let indexedDbCalls = 0;

QUnit.module("discourse-encrypt:lib:database-safari", {
  beforeEach() {
    indexedDbCalls = 0;

    setIndexedDb({
      open(name, version) {
        return window.indexedDB.open(name, version);
      },

      databases() {
        return indexedDbCalls++ > 3
          ? window.indexedDB.databases()
          : new Promise(() => {});
      },

      deleteDatabase(name) {
        indexedDbCalls++;
        return window.indexedDB.deleteDatabase(name);
      },
    });

    setUserAgent("iPhone");
  },

  afterEach() {
    setIndexedDb(window.indexedDB);
    setUserAgent(window.navigator.userAgent);
  },
});

test("IndexedDB is initialized in Safari", async (assert) => {
  await deleteDb();
  assert.rejects(loadDbIdentity());
  assert.ok(indexedDbCalls > 0);
});
