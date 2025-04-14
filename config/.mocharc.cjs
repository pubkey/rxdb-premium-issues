const mochaSettings = {
    bail: true,
    timeout: 10000,
    exit: true,
    reporter: 'spec',
    "node-option": ["import=tsx"]
};

if (process.env.NODE_PROF) {
    console.log('profiler activated:');
    mochaSettings.prof = true;
    mochaSettings.bail = false;
}

module.exports = mochaSettings;
