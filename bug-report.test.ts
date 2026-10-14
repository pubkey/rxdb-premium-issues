/**
 * Bug: after a schema migration is interrupted, retrying startMigration()
 * after reopening the database never resolves and exhausts the heap.
 *
 * Node only: npm run test:node
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    addRxPlugin,
    createRxDatabase,
    randomToken
} from 'rxdb/plugins/core';
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema';
import {
    getRxStorageSQLite,
    getSQLiteBasicsNodeNative
} from 'rxdb-premium/plugins/storage-sqlite';
import { filter, firstValueFrom } from 'rxjs';

const CHILD_PROCESS_ENV = 'RXDB_INTERRUPTED_MIGRATION_CHILD';

const schemaV0 = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id: { type: 'string', maxLength: 100 },
        value: { type: 'string' }
    },
    required: ['id', 'value']
};

const schemaV1 = {
    ...schemaV0,
    version: 1,
    properties: {
        ...schemaV0.properties,
        added: { type: 'boolean' }
    }
};

const migrationStrategies = {
    1: (document: Record<string, unknown>) => document
};

async function runInterruptedMigrationProbe(): Promise<void> {
    addRxPlugin(RxDBMigrationSchemaPlugin);

    const name = process.env.RXDB_INTERRUPTED_MIGRATION_DB
        || join(tmpdir(), 'interrupted-migration-' + randomToken(10));
    const storage = getRxStorageSQLite({
        sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync)
    });
    const collectionConfig = {
        schema: schemaV1,
        autoMigrate: false,
        migrationStrategies
    };

    const original = await createRxDatabase({
        name,
        storage,
        multiInstance: false
    });
    const originalCollections = await original.addCollections({
        items: { schema: schemaV0 }
    });
    await originalCollections.items.bulkInsert(
        Array.from({ length: 25 }, (_, index) => ({
            id: 'item-' + index,
            value: String(index)
        }))
    );
    await original.close();

    const interrupted = await createRxDatabase({
        name,
        storage,
        multiInstance: false
    });
    const interruptedCollections = await interrupted.addCollections({
        items: collectionConfig
    });
    const interruptedState = interruptedCollections.items.getMigrationState();
    void interruptedState.startMigration(1).catch(() => undefined);
    const interruptedStatus = await firstValueFrom(
        interruptedState.$.pipe(filter(status => status.count.handled > 0))
    );
    process.stdout.write('INTERRUPTED_AFTER=' + interruptedStatus.count.handled + '\n');
    await interruptedState.cancel();
    await interrupted.close();

    const resumed = await createRxDatabase({
        name,
        storage,
        multiInstance: false
    });
    const resumedCollections = await resumed.addCollections({
        items: collectionConfig
    });

    process.stdout.write('RESUME_STARTED\n');
    await resumedCollections.items.getMigrationState().startMigration(1);
    process.stdout.write('RESUME_FINISHED\n');
    await resumed.close();
}

if (process.env[CHILD_PROCESS_ENV] === '1') {
    runInterruptedMigrationProbe().then(
        () => process.exit(0),
        error => {
            console.error(error);
            process.exit(1);
        }
    );
} else {
    describe('interrupted schema migration', () => {
        it('should resume after the database is reopened', async function () {
            this.timeout(30_000);

            const workingDirectory = await mkdtemp(
                join(tmpdir(), 'rxdb-interrupted-migration-')
            );
            const child = spawn(
                process.execPath,
                [
                    '--max-old-space-size=96',
                    '--import=tsx',
                    join(process.cwd(), 'bug-report.test.ts')
                ],
                {
                    cwd: process.cwd(),
                    env: {
                        ...process.env,
                        [CHILD_PROCESS_ENV]: '1',
                        RXDB_INTERRUPTED_MIGRATION_DB: join(
                            workingDirectory,
                            'interrupted-migration-' + randomToken(10)
                        )
                    },
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
            });
            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
            });

            let killedByDeadline = false;
            const deadline = setTimeout(() => {
                killedByDeadline = true;
                child.kill('SIGKILL');
            }, 10_000);
            const outcome = await new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null;
            }>(resolve => {
                child.once('exit', (code, signal) => {
                    clearTimeout(deadline);
                    resolve({ code, signal });
                });
            });
            await rm(workingDirectory, { recursive: true, force: true });

            assert.match(stdout, /INTERRUPTED_AFTER=[1-9]/);
            assert.match(stdout, /RESUME_STARTED/);
            assert.match(
                stdout,
                /RESUME_FINISHED/,
                'startMigration() did not resume.\n' +
                    'killedByDeadline=' + killedByDeadline + '\n' +
                    'exitCode=' + outcome.code + '\n' +
                    'signal=' + outcome.signal + '\n' +
                    'stdout:\n' + stdout + '\n' +
                    'stderr:\n' + stderr
            );
            assert.strictEqual(outcome.code, 0);
        });
    });
}
