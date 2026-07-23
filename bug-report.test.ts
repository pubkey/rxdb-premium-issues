/**
 * Bug: abstract-filesystem cleanup() crashes permanently with
 * "TypeError: Cannot read properties of undefined (reading '_deleted')"
 * when a _meta.lwt index row points at a byte range that contains only spaces.
 *
 * Mechanism (plugins/storage-abstract-filesystem):
 * - cleanupDocumentJsonFile() walks the ['_meta.lwt', <primary>] index rows and,
 *   for every document that has to move during compaction, reads its bytes via
 *   getDocumentsJson().
 * - getDocumentsJson() wraps the decoded byte range as "[" + decoded + "]" and
 *   JSON.parse()s it. A range that is entirely spaces is *valid* JSON ("[   ]"
 *   parses to []), so no SyntaxError is thrown and the function silently
 *   resolves with FEWER documents than index rows were passed in.
 * - The caller does `docs[0]` without checking, gets `undefined`, and
 *   IndexState.changeDocumentPosition(undefined) throws the TypeError inside
 *   getIndexableString(). Because the crash happens on every cleanup cycle for
 *   the same row, compaction is permanently wedged for that collection.
 *
 * Space-padded regions are written by the storage itself (compaction pads the
 * gap it leaves behind, and persistInMemoryRows pads index files), so a stale
 * or duplicate index row left behind by an interrupted/crashed cleanup lands
 * exactly in this state. This test constructs the damaged state directly on
 * disk (space-filling one document's byte range in place, at identical length,
 * while keeping its index rows) and then shows that cleanup() can never
 * complete again.
 *
 * Expected behavior instead of the crash: detect the row/document mismatch and
 * fail loudly (or drop/skip the provably dead row) — see also the shape
 * validation ask in pubkey/rxdb#8841 (a different bug, but the same missing
 * "validate internal resolution shapes" posture).
 *
 * Runs in Node only ('npm run test:node') — it uses
 * rxdb-premium/plugins/storage-filesystem-node and manipulates the store
 * files on disk.
 */
import assert from 'assert';

import { randomToken } from 'rxdb/plugins/core';
import { isNode } from 'rxdb/plugins/test-utils';

const schema = {
    title: 'cleanup whitespace-row probe',
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id: { type: 'string', maxLength: 100 },
        value: { type: 'string' },
        _deleted: { type: 'boolean' },
        _rev: { type: 'string', minLength: 1 },
        _meta: {
            type: 'object',
            properties: {
                lwt: {
                    type: 'number',
                    minimum: 1,
                    maximum: 1_000_000_000_000_000,
                    multipleOf: 0.01
                }
            },
            required: ['lwt'],
            additionalProperties: false
        },
        _attachments: { type: 'object' }
    },
    required: ['id', 'value', '_deleted', '_rev', '_meta', '_attachments'],
    indexes: [['_deleted', 'id']]
} as any;

function storageParams(token: string) {
    return {
        databaseName: 'cleanup-whitespace-db',
        collectionName: 'products',
        schema,
        options: {},
        multiInstance: false,
        devMode: false,
        databaseInstanceToken: token
    };
}

function document(id: string, sequence: number, lwt: number) {
    return {
        id,
        value: `value-${id}`,
        _deleted: false,
        _rev: `1-probe${sequence}`,
        _meta: { lwt },
        _attachments: {}
    };
}

/**
 * Space-fill one document's byte range in documents.json IN PLACE (identical
 * length, so no other document moves), while leaving every index row intact.
 * This is the damage shape a stale index row into a compaction-padded region
 * produces.
 */
async function spaceFillRecordInPlace(basePath: string, id: string) {
    // dynamic 'node:'-imports (with concatenation so the browser bundler
    // never tries to resolve them — this test is Node-only anyway)
    const { readdir, readFile, writeFile } = await import('node:fs/promises' + '');
    const { join } = await import('node:path' + '');
    const directory = join(basePath, (await readdir(basePath))[0]);
    const indexFileName = (await readdir(directory)).find((name) =>
        name.startsWith('index-')
    );
    assert.ok(indexFileName, 'no index file found');
    const rows = JSON.parse(
        await readFile(join(directory, indexFileName), 'utf8')
    );
    const targetRow = rows.find((row: [string, number, number]) =>
        row[0].includes(id)
    );
    assert.ok(targetRow, `missing index row for ${id}`);

    const documentsPath = join(directory, 'documents.json');
    const documents = await readFile(documentsPath);
    const start: number = targetRow[1];
    const end: number = targetRow[2];
    await writeFile(
        documentsPath,
        Buffer.concat([
            documents.subarray(0, start),
            Buffer.alloc(end - start, 32), // 32 = ASCII space
            documents.subarray(end)
        ])
    );
}

describe('bug-report.test.ts', () => {
    it('should fail because it reproduces the bug', async function () {
        this.timeout(30_000);
        if (!isNode) {
            // filesystem-node storage + direct file manipulation: Node only.
            return;
        }
        const { getRxStorageFilesystemNode } = await import(
            'rxdb-premium/plugins/storage-filesystem-node' + ''
        );
        const { mkdtemp, rm } = await import('node:fs/promises' + '');
        const { tmpdir } = await import('node:os' + '');
        const { join } = await import('node:path' + '');

        const basePath = await mkdtemp(join(tmpdir(), 'rxdb-cleanup-bug-'));
        const baseLwt = Date.now() - 10_000;
        const toDelete = document('product:deleted', 0, baseLwt);
        const dead = document('product:dead', 1, baseLwt + 1);
        const survivor = document('product:survivor', 2, baseLwt + 2);

        try {
            const storage = getRxStorageFilesystemNode({ basePath });
            const instance = await storage.createStorageInstance(
                storageParams(randomToken(10))
            );

            await instance.bulkWrite(
                [toDelete, dead, survivor].map((item) => ({ document: item })),
                'seed'
            );
            // settle initial compaction/changelog
            while (!(await instance.cleanup(0))) { }

            // delete the first document -> its removal during the next cleanup
            // opens a gap in documents.json, so later documents have to MOVE
            // during compaction (the code path that reads via getDocumentsJson)
            await instance.bulkWrite(
                [
                    {
                        previous: toDelete,
                        document: {
                            ...toDelete,
                            _deleted: true,
                            _rev: '2-deleted',
                            _meta: { lwt: baseLwt + 100 }
                        }
                    }
                ],
                'delete'
            );
            // run cleanup just far enough to purge the deleted document's rows
            // (leaving the gap in documents.json not yet compacted)
            assert.strictEqual(await instance.cleanup(0), false);
            assert.strictEqual(await instance.cleanup(0), false);
            await instance.close();

            // damage: the second document's bytes become pure whitespace while
            // its index rows survive
            await spaceFillRecordInPlace(basePath, dead.id);

            const reopened = await getRxStorageFilesystemNode({
                basePath
            }).createStorageInstance(storageParams(randomToken(10)));

            /**
             * BUG IS HERE:
             * this cleanup() call rejects with
             *   TypeError: Cannot read properties of undefined (reading '_deleted')
             * from IndexState.changeDocumentPosition -> getIndexableString,
             * because getDocumentsJson parsed the whitespace range to [] and
             * cleanupDocumentJsonFile used docs[0] (undefined) unchecked.
             * Every subsequent cleanup() hits the same row again, so compaction
             * never completes for this collection anymore.
             *
             * Expected: cleanup() surfaces a descriptive storage-corruption
             * error (or skips/drops the provably dead row) instead of the
             * TypeError, and eventually settles.
             */
            let done = false;
            for (let i = 0; i < 10 && !done; i++) {
                done = await reopened.cleanup(0);
            }
            assert.strictEqual(done, true);

            // the undamaged document must still be intact
            const found = await reopened.findDocumentsById([survivor.id], false);
            assert.strictEqual(found.length, 1);
            assert.strictEqual(found[0].id, survivor.id);

            await reopened.close();
        } finally {
            await rm(basePath, { recursive: true, force: true });
        }
    });
});
