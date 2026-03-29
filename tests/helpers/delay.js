'use strict';

/**
 * Random delay between tests to avoid hammering rate-limited APIs.
 * Use in afterEach() in each test file.
 */
function randomDelay(minMs = 3000, maxMs = 6000) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { randomDelay };
