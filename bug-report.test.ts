/**
 * Bug reproduction test for:
 * SQLite storage throws "no such table: main.plugin-local-documents-{collection}-0"
 * during schema migration from v0 to v1.
 *
 * To run this test do:
 * - 'npm run test:node' so it runs in nodejs
 * - 'npm run test:browser' so it runs in the browser
 */
import assert from "assert";

import { createRxDatabase, randomToken, addRxPlugin } from "rxdb/plugins/core";

import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { RxDBQueryBuilderPlugin } from "rxdb/plugins/query-builder";
import { RxDBMigrationPlugin } from "rxdb/plugins/migration-schema";

import { isNode } from "rxdb/plugins/test-utils";

/**
 * You can import any RxDB Premium Plugins here
 */
// import { getRxStorageIndexedDB } from "rxdb-premium/plugins/storage-indexedb";

describe("bug-report.test.ts", () => {
  addRxPlugin(RxDBDevModePlugin);
  addRxPlugin(RxDBQueryBuilderPlugin);
  addRxPlugin(RxDBMigrationPlugin);

  it('should fail because migration throws "no such table: main.plugin-local-documents-{collection}-0"', async function () {
    this.timeout(10000);

    let storage: any;
    if (isNode) {
      const { DatabaseSync } = require("node:sqlite" + "");
      const {
        getRxStorageSQLite,
        getSQLiteBasicsNodeNative,
      } = require("rxdb-premium/plugins/storage-sqlite");
      storage = getRxStorageSQLite({
        sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync),
      });
    } else {
      //   storage = getRxStorageIndexedDB();
    }
    storage = wrappedValidateAjvStorage({
      storage,
    });

    const schemaV0 = {
      version: 0,
      primaryKey: "id",
      type: "object",
      properties: {
        id: {
          type: "string",
          maxLength: 100,
        },
        name: {
          type: "string",
        },
        active: {
          type: "boolean",
        },
      },
      required: ["id", "name", "active"],
    };

    const schemaV1 = {
      version: 1,
      primaryKey: "id",
      type: "object",
      properties: {
        id: {
          type: "string",
          maxLength: 100,
        },
        name: {
          type: "string",
        },
        active: {
          type: "boolean",
        },
        nota_number_daily_reset: {
          type: "boolean",
        },
      },
      required: ["id", "name", "active"],
    };

    /**
     * Always generate a random database-name
     * to ensure that different test runs do not affect each other.
     */
    const name = randomToken(10);

    // Step 1: Create database with v0 schema and insert a document
    console.log("[Step 1] Creating database with v0 schema...");
    const db = await createRxDatabase({
      name,
      storage,
      eventReduce: true,
      ignoreDuplicate: true,
    });
    console.log("[Step 1] Database created:", name);

    await db.addCollections({
      bill_design: {
        schema: schemaV0,
      },
    });
    console.log("[Step 1] Collection 'bill_design' added with schemaV0");

    await db.collections.bill_design.insert({
      id: "bd-1",
      name: "Default Design",
      active: true,
    });
    console.log(
      "[Step 1] Document inserted: { id: 'bd-1', name: 'Default Design', active: true }",
    );

    // Verify document was inserted
    const doc = await db.collections.bill_design.findOne().exec();
    assert.ok(doc);
    assert.strictEqual(doc.id, "bd-1");
    console.log("[Step 1] Document verified:", JSON.stringify(doc.toJSON()));

    // Step 2: Close the database
    console.log("[Step 2] Closing database...");
    await db.close();
    console.log("[Step 2] Database closed");

    // Step 3: Reopen with v1 schema and migration strategy — this should trigger the bug
    console.log(
      "[Step 3] Reopening database with v1 schema and migration strategy...",
    );
    const db2 = await createRxDatabase({
      name,
      storage,
      eventReduce: true,
      ignoreDuplicate: true,
    });
    console.log("[Step 3] Database reopened");

    console.log(
      "[Step 3] Adding collection with schemaV1 and migrationStrategies...",
    );
    await db2.addCollections({
      bill_design: {
        schema: schemaV1,
        migrationStrategies: {
          1: (oldDoc: any) => {
            console.log(
              "[Migration] Migrating document:",
              JSON.stringify(oldDoc),
            );
            if (oldDoc.nota_number_daily_reset == null) {
              oldDoc.nota_number_daily_reset = false;
            }
            console.log(
              "[Migration] Migrated document:",
              JSON.stringify(oldDoc),
            );
            return oldDoc;
          },
        },
      },
    });
    console.log("[Step 3] Collection added with v1 schema");

    // Wait for migration to complete
    console.log("[Step 4] Starting migration...");
    const migrationState = db2.collections.bill_design.getMigrationState();
    await migrationState.migratePromise(10000);
    console.log("[Step 4] Migration completed");

    // Verify the migrated document has the new field
    console.log("[Step 5] Verifying migrated document...");
    const migratedDoc = await db2.collections.bill_design.findOne().exec();
    assert.ok(migratedDoc);
    assert.strictEqual(migratedDoc.id, "bd-1");
    assert.strictEqual(migratedDoc.name, "Default Design");
    assert.strictEqual(migratedDoc.active, true);
    assert.strictEqual(migratedDoc.nota_number_daily_reset, false);
    console.log(
      "[Step 5] Migrated document verified:",
      JSON.stringify(migratedDoc.toJSON()),
    );

    // clean up
    console.log("[Step 6] Cleaning up...");
    await db2.close();
    console.log("[Step 6] Done");
  });
});
