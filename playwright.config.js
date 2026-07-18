// playwright.config.js
//
// The default test run (scripts/run-e2e.sh → `npx playwright test`) exercises
// ONLY the full-build end-to-end suite in test/e2e.spec.js (6 tests). The
// chat-only lite verification lives in test/lite.spec.js and is opt-in behind
// the LEXI_LITE env var (scripts/run-lite-e2e.sh sets it) so it never changes
// the full suite's test count.
//
// Discovery is switched by testMatch rather than testDir so both spec files can
// live side-by-side in test/ without one leaking into the other's run.
'use strict';

const isLite = !!process.env.LEXI_LITE;

module.exports = {
  testDir: './test',
  testMatch: isLite ? /lite\.spec\.js$/ : /e2e\.spec\.js$/,
};
