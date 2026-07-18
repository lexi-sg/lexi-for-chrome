// playwright.config.js
//
// The default test run (scripts/run-e2e.sh → `npx playwright test`) exercises
// ONLY the full-build end-to-end suite in test/e2e.spec.js (6 tests). The
// chat-only lite verification lives in test/lite.spec.js and is opt-in behind
// the LEXI_LITE env var (scripts/run-lite-e2e.sh sets it) so it never changes
// the full suite's test count. The hermetic account-mode + product-chat suite
// (mocked backend, no ANTHROPIC_API_KEY/staging creds needed) lives in
// test/account-mode.spec.js and is opt-in behind LEXI_ACCOUNT_MODE for the
// same reason. The runtime channel-switch suite (server-flippable
// prod/staging resolution via GET /api/extension/runtime-config) lives in
// test/channel-config.spec.js and is opt-in behind LEXI_CHANNEL for the same
// reason.
//
// Discovery is switched by testMatch rather than testDir so all spec files can
// live side-by-side in test/ without one leaking into another's run.
'use strict';

const isLite = !!process.env.LEXI_LITE;
const isAccountMode = !!process.env.LEXI_ACCOUNT_MODE;
const isChannel = !!process.env.LEXI_CHANNEL;

module.exports = {
  testDir: './test',
  testMatch: isChannel
    ? /channel-config\.spec\.js$/
    : isAccountMode
      ? /account-mode\.spec\.js$/
      : isLite
        ? /lite\.spec\.js$/
        : /e2e\.spec\.js$/,
};
