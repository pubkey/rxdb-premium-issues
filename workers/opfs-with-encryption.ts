/**
 * OPFS worker WITH encryption inside the worker.
 * This is the FAILING case — encryption wrapper calls .map()
 * on OPFS findDocumentsById result which is a JSON string.
 */
import { setPremiumFlag } from 'rxdb-premium/plugins/shared';
setPremiumFlag();

import { getRxStorageOPFS } from 'rxdb-premium/plugins/storage-opfs';
import { wrappedKeyEncryptionWebCryptoStorage } from 'rxdb-premium/plugins/encryption-web-crypto';
import { exposeWorkerRxStorage } from 'rxdb-premium/plugins/storage-worker';

exposeWorkerRxStorage({
    storage: wrappedKeyEncryptionWebCryptoStorage({
        storage: getRxStorageOPFS()
    })
});
