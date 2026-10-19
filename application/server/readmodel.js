// Read-model agregado sobre la topología jerárquica de canales.
//
// Con el activo naciendo en el canal de su provincia y ascendiendo al nacional
// sólo cuando cruza una frontera (ver chaincode PublishAssetRef + actions.js),
// el índice ya no vive en un solo canal: una lectura completa tiene que unir el
// canal nacional con cada canal provincial y de-duplicar. Cada canal se lee con
// UNA org miembro (un peer no miembro no puede leer un canal ajeno); un canal
// caído o no-miembro se saltea en vez de tirar la respuesta entera.
'use strict';

const { evaluateJSONOn, defaultOrgKey } = require('./connections');
const { NATIONAL_CHANNEL, jurisdictionChannels } = require('../src/config');

// channelReaders -> [{ channel, orgKey }]: el nacional (cualquier activa) y un
// miembro por cada canal jurisdiccional activo.
function channelReaders() {
  const readers = [{ channel: NATIONAL_CHANNEL, orgKey: defaultOrgKey() }];
  for (const { channel, orgs } of Object.values(jurisdictionChannels())) {
    if (channel && orgs && orgs.length) readers.push({ channel, orgKey: orgs[0] });
  }
  return readers;
}

// aggregate corre una query de listado en todos los canales legibles y une los
// resultados de-duplicando por keyOf. Conserva el canal de origen en _channel.
async function aggregate(fn, keyOf) {
  const readers = channelReaders();
  const lists = await Promise.all(readers.map((r) =>
    evaluateJSONOn(r.orgKey, r.channel, fn)
      .then((xs) => xs.map((x) => ({ ...x, _channel: r.channel })))
      .catch(() => [])));
  const seen = new Map();
  for (const list of lists) {
    for (const x of list) {
      const k = keyOf(x);
      if (!seen.has(k)) seen.set(k, x);
    }
  }
  return [...seen.values()];
}

// Un activo provincial y su referencia nacional colapsan por FhirResourceID; el
// _channel/OriginChannel conserva la proveniencia.
const allAssets = () => aggregate('GetAllAssets', (a) => a.FhirResourceID);
const allConsents = () => aggregate('GetAllConsents', (c) => `${c.PatientIDHash}_${c.GrantedToOrg}`);
const allAccessLogs = () => aggregate('GetAllAccessLogs', (l) => l.TxID);

// findAsset resuelve un activo (y su canal de origen) mirando la unión de todos
// los canales. Lo usan checkAccess (para rutear) y keys.js.
async function findAsset(fhirResourceID) {
  const asset = (await allAssets()).find((a) => a.FhirResourceID === fhirResourceID);
  if (!asset) throw new Error(`El activo ${fhirResourceID} no existe`);
  return asset;
}

module.exports = { channelReaders, aggregate, allAssets, allConsents, allAccessLogs, findAsset };
