# rxdb-premium-issues

Repo to submit bug reports and test cases for the [RxDB Premium Plugins](https://rxdb.info/premium/)

## Bug: `wrappedKeyEncryptionWebCryptoStorage` incompatible with `getRxStorageOPFS` inside Worker

### Summary

The [encryption documentation](https://rxdb.info/encryption.html) recommends running encryption inside workers for better performance. However, wrapping `getRxStorageOPFS()` with `wrappedKeyEncryptionWebCryptoStorage()` inside a worker causes a `TypeError` because the OPFS storage returns JSON strings from `findDocumentsById` instead of arrays.

### Error

```
TypeError: findResult.map is not a function
    at wrappedKeyEncryptionWebCryptoStorage -> findDocumentsById
```

### Root Cause

The OPFS storage (`storage-abstract-filesystem/find-by-ids.ts`) returns JSON strings from `findDocumentsById()` as a performance optimization for the worker communication layer:

```js
// find-by-ids.ts — returns a JSON string, not an array
var a = "[]";
export async function findDocumentsByIds(r, n, i, s) {
    // ...
    if (0 === d.length) return a;  // returns "[]" string
    return await getDocumentsJsonString(o, v, s, d);  // returns JSON string
}
```

The encryption wrapper intercepts `findDocumentsById` and calls `.map()` on the result to decrypt encrypted fields — but `.map()` does not exist on strings.

This works fine when `exposeWorkerRxStorage` directly wraps the OPFS storage (the worker proxy handles string-to-array deserialization). But any storage wrapper placed between OPFS and `exposeWorkerRxStorage` (like encryption) receives the raw JSON string and breaks.

### Reproduction

**Worker file that FAILS:**
```ts
import { getRxStorageOPFS } from 'rxdb-premium/plugins/storage-opfs';
import { wrappedKeyEncryptionWebCryptoStorage } from 'rxdb-premium/plugins/encryption-web-crypto';
import { exposeWorkerRxStorage } from 'rxdb-premium/plugins/storage-worker';

exposeWorkerRxStorage({
    storage: wrappedKeyEncryptionWebCryptoStorage({
        storage: getRxStorageOPFS()
    })
});
```

**Main thread:**
```ts
import { createRxDatabase } from 'rxdb';
import { getRxStorageWorker } from 'rxdb-premium/plugins/storage-worker';

const db = await createRxDatabase({
    name: 'mydb',
    storage: getRxStorageWorker({
        workerInput: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    }),
    password: { algorithm: 'AES-GCM', password: 'myPassword12345678' }
});

await db.addCollections({
    items: {
        schema: {
            version: 0,
            primaryKey: 'id',
            type: 'object',
            properties: {
                id: { type: 'string', maxLength: 100 },
                secret: { type: 'string' }
            },
            required: ['id', 'secret'],
            encrypted: ['secret']
        }
    }
});

// This triggers findDocumentsById internally -> TypeError
await db.items.insert({ id: 'test', secret: 'value' });
```

### Workaround

Run encryption on the main thread wrapping the worker proxy (after deserialization):

```ts
// Worker: bare OPFS, no encryption
exposeWorkerRxStorage({ storage: getRxStorageOPFS() });

// Main thread: encryption wraps the worker proxy
const storage = wrappedKeyEncryptionWebCryptoStorage({
    storage: getRxStorageWorker({
        workerInput: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    })
});
```

This works because the worker proxy (`getRxStorageWorker`) deserializes the JSON strings back to arrays before returning them to the main thread, so the encryption wrapper receives proper arrays.

**Downside:** Encryption runs on the main thread, negating the performance benefit of using workers for CPU-intensive crypto operations.

### Suggested Fix

The encryption wrapper should handle both array and JSON-string results from `findDocumentsById`:

```js
const findResult = await originalFindDocumentsById(ids, deleted);
const docs = typeof findResult === 'string' ? JSON.parse(findResult) : findResult;
return docs.map(doc => decryptFields(doc));
```

Alternatively, the OPFS storage could detect that it has been wrapped by another storage plugin and return standard arrays instead of optimized JSON strings. Or the OPFS storage could normalize its return type to always return arrays, keeping the string optimization internal.

### Versions

- `rxdb`: 16.21.1
- `rxdb-premium`: 16.21.1

### Notes

- `getRxStorageIndexedDB` + encryption inside a worker works fine (IndexedDB returns proper arrays)
- Only `getRxStorageOPFS` is affected (its `storage-abstract-filesystem` base uses JSON string optimization)
- The control test in `bug-report.test.ts` verifies IndexedDB + encryption works correctly

## How to run

```sh
npm install
npm run test:browser   # runs the browser test in Karma
npm run test:node      # runs the node test (skips OPFS tests)
```
