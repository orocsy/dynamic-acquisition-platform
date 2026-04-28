'use strict';

module.exports = {
  ...require('./classifyNetworkEntry'),
  ...require('./extractRequestSignals'),
  ...require('./extractResponseSignals'),
  ...require('./normalizeNetworkEvidence'),
};
