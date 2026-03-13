const greenhouse = require('./greenhouse');
const ashby = require('./ashby');
const lever = require('./lever');
const workable = require('./workable');
const recruitee = require('./recruitee');

const adapters = {
  greenhouse,
  ashby,
  lever,
  workable,
  recruitee,
};

function getAdapter(atsName) {
  const adapter = adapters[atsName];
  if (!adapter) throw new Error(`Unsupported ATS: ${atsName}`);
  return adapter;
}

module.exports = { getAdapter };
