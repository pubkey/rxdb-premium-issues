/**
 * this is a template for a test.
 * If you found a bug, edit this test to reproduce it
 * and than make a pull-request with that failing test.
 * The maintainer will later move your test to the correct position in the test-suite.
 *
 * To run this test do:
 * - 'npm run test:node' so it runs in nodejs
 * - 'npm run test:browser' so it runs in the browser
 */
import assert from "assert";
import AsyncTestUtil from "async-test-util";

import { createRxDatabase, randomToken, addRxPlugin } from "rxdb/plugins/core";

import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { RxDBQueryBuilderPlugin } from "rxdb/plugins/query-builder";

import { isNode } from "rxdb/plugins/test-utils";

/**
 * You can import any RxDB Premium Plugins here
 */
import { getRxStorageIndexedDB } from "rxdb-premium/plugins/storage-indexeddb";
import {
  getRxStorageSQLite,
  getSQLiteBasicsNodeNative,
} from "rxdb-premium/plugins/storage-sqlite";

describe("bug-report.test.ts", () => {
  addRxPlugin(RxDBDevModePlugin);
  addRxPlugin(RxDBQueryBuilderPlugin);

  it("sqlite storage fails querying", async function () {
    let storage: any;
    if (isNode) {
      const { DatabaseSync } = require("node:sqlite" + "");
      storage = getRxStorageSQLite({
        sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync),
      });
    } else {
      storage = getRxStorageIndexedDB();
    }
    storage = wrappedValidateAjvStorage({
      storage,
    });

    // create a schema
    const mySchema = {
      version: 0,
      primaryKey: "id",
      type: "object",
      properties: {
        id: {
          type: "string",
          maxLength: 100,
        },
        expiresAt: {
          type: ["string", "null"],
          format: "date-time",
        },
      },
    };

    /**
     * Always generate a random database-name
     * to ensure that different test runs do not affect each other.
     */
    const name = randomToken(10);

    // create a database
    const db = await createRxDatabase({
      name,
      storage: storage,
      eventReduce: true,
      ignoreDuplicate: true,
    });
    // create a collection
    const collections = await db.addCollections({
      mycollection: {
        schema: mySchema,
      },
    });
    await collections.mycollection.insert({
      id: "a",
      expiresAt: null,
    });
    await collections.mycollection.insert({
      id: "b",
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
    });
    await collections.mycollection.insert({
      id: "c",
      expiresAt: new Date(Date.now() - 100_000).toISOString(),
    });

    const found = await collections.mycollection
      .find({
        selector: {
          $or: [
            { expiresAt: { $gt: new Date().toISOString() } },
            { expiresAt: null },
          ],
        },
        sort: [{ id: "asc" }],
      })
      .exec();

    assert.ok(Array.isArray(found));
    assert.ok(found.length === 2);
    assert.ok(found[0].id === "a");
    assert.ok(found[1].id === "b");
  });
});
