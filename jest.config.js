// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const base = require('./.config/jest.config');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...base,
  transform: {
    ...base.transform,
    // @grafana/data (via @grafana/ui) imports d3-interpolate and d3-color,
    // which ship only .mjs entries; the scaffolded transform covers .js/.ts.
    // Same SWC transform, so rendering @grafana/ui components works in tests.
    '^.+\\.mjs$': base.transform['^.+\\.(t|j)sx?$'],
  },
};
