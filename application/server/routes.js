// Rutas REST del BFF. Toda respuesta es JSON; los errores de chaincode/red
// salen como 500 { error } — la UI los muestra tal cual (los mensajes del
// chaincode ya son descriptivos, p.ej. "solo X puede revocar...").
'use strict';

const express = require('express');
const fabric = require('./fabric');

const router = express.Router();

const wrap = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    const message = err.details?.[0]?.message || err.message || String(err);
    res.status(500).json({ error: message });
  }
};

const orgOrDefault = (req) => req.query.org || req.body?.org || 'sancristobal';

router.get('/status', wrap(() => fabric.nodesStatus()));
router.get('/channels', wrap((req) => fabric.channelsStatus(orgOrDefault(req))));

router.get('/assets', wrap((req) => fabric.evaluateJSON(orgOrDefault(req), 'GetAllAssets')));
router.get('/consents', wrap((req) => fabric.evaluateJSON(orgOrDefault(req), 'GetAllConsents')));
router.get('/access-logs', wrap((req) => fabric.evaluateJSON(orgOrDefault(req), 'GetAllAccessLogs')));
router.get('/consents/history', wrap((req) => {
  const { patientIDHash, grantedToOrg } = req.query;
  return fabric.evaluateJSON(orgOrDefault(req), 'GetConsentHistory', patientIDHash, grantedToOrg);
}));

router.get('/deliveries', wrap(() => fabric.deliveries));

router.post('/assets', wrap((req) => fabric.emitAsset(req.body)));
router.post('/consents', wrap((req) => fabric.grantConsent(req.body)));
router.post('/consents/revoke', wrap((req) => fabric.revokeConsent(req.body)));
router.post('/check-access', wrap((req) => fabric.checkAccess(req.body)));
router.post('/deliveries/:id/decrypt', wrap((req) => fabric.decryptDelivery(req.params.id, req.body.org)));

module.exports = router;
