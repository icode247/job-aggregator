const greenhouse = require('./greenhouse');
const ashby = require('./ashby');
const lever = require('./lever');
const workable = require('./workable');
const recruitee = require('./recruitee');
const smartrecruiters = require('./smartrecruiters');
const rippling = require('./rippling');

const adapters = {
  greenhouse,
  ashby,
  lever,
  workable,
  recruitee,
  smartrecruiters,
  rippling,
};

function getAdapter(atsName) {
  const adapter = adapters[atsName];
  if (!adapter) throw new Error(`Unsupported ATS: ${atsName}`);
  return adapter;
}

module.exports = { getAdapter };
