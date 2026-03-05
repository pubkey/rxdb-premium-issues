/**
 * Browser stub for rxdb/plugins/test-utils.
 * The real module is Node-only (reads process.env.DEFAULT_STORAGE etc.).
 * In the browser, only isNode = false is needed.
 */
exports.isNode = false;
exports.isBun = false;
exports.isDeno = false;
