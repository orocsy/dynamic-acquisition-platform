'use strict';

module.exports = {
  ...require('./intent.schema'),
  ...require('./evidence.schema'),
  ...require('./plan.schema'),
  ...require('./artifact.schema'),
  ...require('./failure.schema'),
};
