// karma.conf.js
const webpack = require('webpack');

module.exports = function (config) {
    config.set({
        // The testing framework you'll be using
        frameworks: ['mocha'],

        // Files/patterns to load into the browser
        files: [
            { pattern: 'bug-report.test.ts', watched: false }
        ],

        // Preprocess the test file with webpack (bundles TypeScript + dependencies for the browser)
        preprocessors: {
            'bug-report.test.ts': ['webpack', 'sourcemap']
        },

        // webpack configuration for bundling the tests
        webpack: {
            mode: 'development',
            devtool: 'inline-source-map',
            resolve: {
                extensions: ['.ts', '.tsx', '.js']
            },
            module: {
                rules: [{
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/
                }]
            },
            plugins: [
                new webpack.ProvidePlugin({
                    process: 'process'
                })
            ]
        },

        // Report test results
        reporters: ['progress'],

        // Custom launcher for headless Chrome (used in CI)
        customLaunchers: {
            ChromeHeadlessCI: {
                base: 'ChromeHeadless',
                flags: ['--no-sandbox', '--disable-gpu']
            }
        },

        // Use ChromeHeadlessCI in CI environments, Chrome locally
        browsers: [process.env.CI ? 'ChromeHeadlessCI' : 'Chrome'],

        // Karma plugins loaded
        plugins: [
            'karma-mocha',
            'karma-webpack',
            'karma-chrome-launcher',
            'karma-safari-launcher',
            'karma-firefox-launcher',
            'karma-ie-launcher',
            'karma-typescript',
            'karma-opera-launcher',
            'karma-detect-browsers',
            'karma-spec-reporter',
            'karma-sourcemap-loader'
        ],

        // Exit after running tests once
        singleRun: true
    });
};
