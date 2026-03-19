/**
 * Bug Report: wrappedKeyEncryptionWebCryptoStorage incompatible with
 * getRxStorageOPFS when used inside a Worker.
 *
 * The documentation recommends running encryption inside workers:
 * https://rxdb.info/encryption.html
 *
 *   "If you are using Worker RxStorage or SharedWorker RxStorage with
 *    encryption, it's recommended to run encryption inside of the worker."
 *
 * However, wrapping getRxStorageOPFS() with
 * wrappedKeyEncryptionWebCryptoStorage() inside a worker causes:
 *
 *   TypeError: findResult.map is not a function
 *
 * ROOT CAUSE:
 * The OPFS storage (storage-abstract-filesystem/find-by-ids.ts)
 * returns JSON strings from findDocumentsById() as an optimization.
 * The encryption wrapper calls .map() on the result expecting an
 * array. Strings don't have .map() -> TypeError.
 *
 * SUGGESTED FIX:
 * The encryption wrapper should handle both formats:
 *   const docs = typeof findResult === 'string'
 *       ? JSON.parse(findResult) : findResult;
 *   return docs.map(doc => decryptFields(doc));
 *
 * Worker files:
 * - workers/opfs-with-encryption.ts: OPFS + encryption (FAILS)
 * - workers/opfs-bare.ts: bare OPFS (used with main-thread encryption, WORKS)
 */
import assert from 'assert';

import {
    createRxDatabase,
    randomToken,
    addRxPlugin,
    type RxJsonSchema
} from 'rxdb/plugins/core';

import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';

import {
    isNode
} from 'rxdb/plugins/test-utils';

import { setPremiumFlag } from 'rxdb-premium/plugins/shared';
import { getRxStorageWorker } from 'rxdb-premium/plugins/storage-worker';
import { wrappedKeyEncryptionWebCryptoStorage } from 'rxdb-premium/plugins/encryption-web-crypto';

describe('bug-report: OPFS encryption in worker', () => {

    addRxPlugin(RxDBDevModePlugin);
    addRxPlugin(RxDBQueryBuilderPlugin);
    setPremiumFlag();

    const schema: RxJsonSchema<any> = {
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 100 },
            name: { type: 'string' },
            secret: { type: 'string' }
        },
        required: ['id', 'name', 'secret'],
        encrypted: ['secret']
    };

    const password = { algorithm: 'AES-GCM', password: 'myTestPasswordMinLength8' };

    /**
     * FAILS: Encryption inside worker wrapping OPFS.
     *
     * Worker (workers/opfs-with-encryption.ts) does:
     *   exposeWorkerRxStorage({
     *       storage: wrappedKeyEncryptionWebCryptoStorage({
     *           storage: getRxStorageOPFS()
     *       })
     *   });
     *
     * The encryption wrapper calls .map() on findDocumentsById result,
     * but OPFS returns a JSON string -> TypeError.
     */
    it('FAILS: encryption inside worker wrapping OPFS', async function () {
        if (isNode) return this.skip();
        this.timeout(15000);

        // Worker with OPFS + encryption inside (pre-built by webpack)
        const storage = wrappedValidateAjvStorage({
            storage: getRxStorageWorker({
                workerInput: '/base/dist/opfs-with-encryption.js'
            })
        });

        const name = randomToken(10);
        const db = await createRxDatabase({
            name,
            storage,
            password,
            eventReduce: true,
            ignoreDuplicate: true
        });

        await db.addCollections({ items: { schema } });

        await db.items.insert({
            id: 'test1',
            name: 'Alice',
            secret: 'my-secret-value'
        });

        const doc = await db.items.findOne('test1').exec(true);
        assert.strictEqual(doc.name, 'Alice');
        assert.strictEqual(doc.secret, 'my-secret-value');

        await db.close();
    });

    /**
     * WORKS: Encryption on main thread wrapping the worker proxy.
     *
     * Worker (workers/opfs-bare.ts) does:
     *   exposeWorkerRxStorage({ storage: getRxStorageOPFS() });
     *
     * Main thread wraps with encryption AFTER the worker proxy
     * deserializes JSON strings back to arrays.
     */
    it('WORKS: encryption on main thread wrapping worker proxy', async function () {
        if (isNode) return this.skip();
        this.timeout(15000);

        // Worker with bare OPFS (pre-built by webpack)
        const workerStorage = getRxStorageWorker({
            workerInput: '/base/dist/opfs-bare.js'
        });

        // Encryption on main thread (workaround)
        const storage = wrappedValidateAjvStorage({
            storage: wrappedKeyEncryptionWebCryptoStorage({
                storage: workerStorage
            })
        });

        const name = randomToken(10);
        const db = await createRxDatabase({
            name,
            storage,
            password,
            eventReduce: true,
            ignoreDuplicate: true
        });

        await db.addCollections({ items: { schema } });

        await db.items.insert({
            id: 'test2',
            name: 'Bob',
            secret: 'another-secret'
        });

        const doc = await db.items.findOne('test2').exec(true);
        assert.strictEqual(doc.name, 'Bob');
        assert.strictEqual(doc.secret, 'another-secret');

        await db.close();
    });
});
