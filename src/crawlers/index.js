const { crawlGoogle } = require('./google');
const { crawlDictionary } = require('./dictionary');
const { crawlSitemaps } = require('./sitemap');

module.exports = { crawlGoogle, crawlDictionary, crawlSitemaps };
