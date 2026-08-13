// Rutas REST del BFF. Toda respuesta es JSON; los errores de chaincode/red
// salen como 500 { error } — la UI los muestra tal cual (los mensajes del
// chaincode ya son descriptivos, p.ej. "solo X puede revocar...").
//
// Es una factory y no un router suelto porque el alta y la baja de clínicas
// tardan ~40 s y van informando su progreso por SSE: necesitan el broadcast
// del hub que vive en index.js.
'use strict';

const express = require('express');

const { evaluateJSON, defaultOrgKey } = require('./connections');
const actions = require('./actions');
const blocks = require('./blocks');
const clinics = require('./clinics');
const health = require('./health');
const keys = require('./keys');

const wrap = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    const message = err.details?.[0]?.message || err.message || String(err);
    res.status(500).json({ error: message });
  }
};

module.exports = function buildRoutes(broadcast) {
  const router = express.Router();

  // Sin org explícita se usa la primera clínica activa: ya no se puede asumir
  // que 'generica1' existe, porque podría estar dada de baja.
  const orgOrDefault = (req) => req.query.org || req.body?.org || defaultOrgKey();

  router.get('/status', wrap(() => health.nodesStatus()));
  router.get('/channels', wrap((req) => health.channelsStatus(orgOrDefault(req))));

  router.get('/clinics', wrap(() => clinics.listClinics()));
  router.post('/clinics', wrap((req) => clinics.addClinic(req.body, broadcast)));
  router.post('/clinics/:key/baja', wrap((req) =>
    clinics.removeClinic({ key: req.params.key, motivo: req.body?.motivo }, broadcast)));
  router.get('/clinics/:mspId/history', wrap((req) =>
    evaluateJSON(orgOrDefault(req), 'GetClinicHistory', req.params.mspId)));

  router.get('/assets', wrap((req) => evaluateJSON(orgOrDefault(req), 'GetAllAssets')));
  router.get('/consents', wrap((req) => evaluateJSON(orgOrDefault(req), 'GetAllConsents')));
  router.get('/access-logs', wrap((req) => evaluateJSON(orgOrDefault(req), 'GetAllAccessLogs')));
  router.get('/consents/history', wrap((req) => {
    const { patientIDHash, grantedToOrg } = req.query;
    return evaluateJSON(orgOrDefault(req), 'GetConsentHistory', patientIDHash, grantedToOrg);
  }));

  // Cabecera del bloque que contiene una transacción: es lo que permite ver en
  // qué bloque quedó asentado un acceso, y no solo su TxID.
  router.get('/blocks/by-tx/:txId', wrap((req) =>
    blocks.blockByTxId(orgOrDefault(req), req.params.txId)));

  router.get('/deliveries', wrap(() => keys.deliveries));

  router.post('/assets', wrap((req) => actions.emitAsset(req.body)));
  router.post('/consents', wrap((req) => actions.grantConsent(req.body)));
  router.post('/consents/revoke', wrap((req) => actions.revokeConsent(req.body)));
  router.post('/check-access', wrap((req) => actions.checkAccess(req.body)));
  router.post('/deliveries/:id/decrypt', wrap((req) => keys.decryptDelivery(req.params.id, req.body.org)));

  return router;
};
