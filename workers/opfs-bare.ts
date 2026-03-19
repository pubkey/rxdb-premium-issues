/**
 * OPFS worker WITHOUT encryption (bare storage).
 * This is the WORKING case — encryption runs on the main thread
 * after the worker proxy deserializes JSON strings to arrays.
 */
import { setPremiumFlag } from 'rxdb-premium/plugins/shared';
setPremiumFlag();

import { getRxStorageOPFS } from 'rxdb-premium/plugins/storage-opfs';
import { exposeWorkerRxStorage } from 'rxdb-premium/plugins/storage-worker';

exposeWorkerRxStorage({
    storage: getRxStorageOPFS()
});
