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
const readmodel = require('./readmodel');
const blocks = require('./blocks');
const clinics = require('./clinics');
const health = require('./health');
const keys = require('./keys');
const renaper = require('./renaper');
const conformance = require('../src/conformance');
const { getChannels, jurisdictionChannels, channelForOrgs, NATIONAL_CHANNEL } = require('../src/config');

const wrap = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    const message = err.details?.[0]?.message || err.message || String(err);
    // Un recurso no conforme no es un fallo del bus sino una entrada rechazada:
    // sale como 422 con el detalle de qué elemento falló, para que el emisor
    // pueda corregirlo. El resto sigue saliendo como 500.
    const status = Number.isInteger(err.status) ? err.status : 500;
    const body = { error: message };
    if (err.report) body.conformance = err.report;
    res.status(status).json(body);
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

  // Lecturas agregadas: unen el canal nacional con cada provincial y de-duplican
  // (readmodel.js), porque con la topología jerárquica el índice ya no vive en
  // un solo canal. Cada ítem trae _channel con su canal de origen.
  router.get('/assets', wrap(() => readmodel.allAssets()));
  router.get('/consents', wrap(() => readmodel.allConsents()));
  router.get('/access-logs', wrap(() => readmodel.allAccessLogs()));
  router.get('/consents/history', wrap((req) => {
    const { patientIDHash, grantedToOrg } = req.query;
    return evaluateJSON(orgOrDefault(req), 'GetConsentHistory', patientIDHash, grantedToOrg);
  }));

  // Cabecera del bloque que contiene una transacción: es lo que permite ver en
  // qué bloque quedó asentado un acceso, y no solo su TxID.
  router.get('/blocks/by-tx/:txId', wrap((req) =>
    blocks.blockByTxId(orgOrDefault(req), req.params.txId, req.query.channel)));

  router.get('/deliveries', wrap(() => keys.deliveries));

  router.post('/assets', wrap((req) => actions.emitAsset(req.body)));
  router.post('/consents', wrap((req) => actions.grantConsent(req.body)));
  router.post('/consents/revoke', wrap((req) => actions.revokeConsent(req.body)));
  router.post('/check-access', wrap((req) => actions.checkAccess(req.body)));
  router.post('/deliveries/:id/decrypt', wrap((req) => keys.decryptDelivery(req.params.id, req.body.org)));

  // Verificación de identidad simulada (RENAPER mock): informativa, no
  // condiciona ninguna transacción del chaincode.
  // Verificación de integridad bajo demanda: descarga el contenido del activo,
  // recalcula su CID y lo contrasta con el anclado en la cadena. Sirve para
  // ejercitar la propiedad sin tener que pasar por una entrega de clave.
  router.post('/assets/:id/verify-integrity', wrap((req) =>
    keys.verifyAssetIntegrity(req.params.id, orgOrDefault(req))));

  // Auditoría de integridad de TODOS los activos (bajo demanda): recalcula el
  // CID de cada blob y lo contrasta con el anclado en la cadena.
  router.get('/integrity/audit', wrap(() => keys.auditIntegrity()));

  // Topología de canales por nivel: el tablero la usa para mostrar la
  // estructura federal de la red en lugar de una lista plana de canales.
  router.get('/topology', wrap(() => ({
    nacional: NATIONAL_CHANNEL,
    jurisdicciones: jurisdictionChannels(),
    canales: getChannels(),
  })));

  // Canal por el que corresponde resolver un intercambio entre dos
  // instituciones: el de la provincia si comparten jurisdicción, el nacional
  // si la cruzan.
  router.get('/topology/channel-for', wrap((req) =>
    ({ channel: channelForOrgs(req.query.a, req.query.b) })));

  // Valida un recurso sin emitirlo. Sirve al tablero para mostrar el
  // resultado de la capa de conformidad y a la batería de pruebas para
  // medir aceptación y rechazo sin tocar la red ni IPFS.
  router.post('/conformance/validate', wrap((req) =>
    conformance.validateResource(req.body?.resourceType, req.body?.resource)));
  router.get('/conformance/profiles', wrap(() => ({
    resourceTypes: conformance.supportedResourceTypes(),
  })));

  router.post('/renaper/validar', wrap((req) => renaper.validar(req.body?.dni)));

  return router;
};
