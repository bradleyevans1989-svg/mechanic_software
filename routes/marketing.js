const { PRODUCT, TYPES, TYPE_KEYS, typeFor } = require('../lib/verticals');
const { checklistItems } = require('../lib/records');

// Public pages that sell the app to each kind of workshop. No login needed.
module.exports = function (app) {
  const types = TYPE_KEYS.map((key) => ({ key, ...TYPES[key] }));

  app.get('/workshops', (req, res) => {
    res.render('marketing/index', { PRODUCT, types });
  });

  app.get('/workshops/:slug', (req, res) => {
    const type = types.find((t) => t.slug === req.params.slug);
    if (!type) return res.status(404).render('message', { title: 'Not found', message: 'That page does not exist.' });
    const sections = checklistItems(typeFor(type.key).checklist, type.key).filter((c) => c.heading).map((c) => c.item);
    const services = type.items.filter(([kind, , , cents]) => kind === 'labour' && cents).slice(0, 8).map(([, , description]) => description);
    res.render('marketing/type', { PRODUCT, types, type, sections, services });
  });
};
