const lookup = require('../lib/vehicle-lookup');

// Rego and VIN lookups for the vehicle forms; answers are JSON for the Look up buttons.
module.exports = function (app) {
  app.get('/lookup/rego', async (req, res) => {
    res.json(await lookup.lookupRego(req.db, req.query.rego, String(req.query.state || '').toUpperCase()));
  });

  app.get('/lookup/vin', (req, res) => {
    res.json(lookup.decodeVin(req.query.vin));
  });
};
