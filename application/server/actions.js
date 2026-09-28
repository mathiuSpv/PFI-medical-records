// Las cuatro operaciones del bus, expuestas al dashboard: emitir un activo,
// otorgar y revocar consentimiento, y pedir acceso. Acá no hay lógica de Fabric
// nueva — es orquestación sobre los módulos ya probados de ../src.
'use strict';

const { getConn, evaluateJSONOn, utf8 } = require('./connections');
const { rememberKey } = require('./keys');
const { findAsset } = require('./readmodel');
const { assertConformant } = require('../src/conformance');
const { encryptResource, assetAAD } = require('../src/crypto');
const { uploadToIPFS } = require('../src/ipfs');
const { patientRef } = require('../src/patient');
const { channelForOrgs, orgKeyForMsp, NATIONAL_CHANNEL } = require('../src/config');

// El identificador del paciente nunca sale de acá en claro ni como hash simple:
// se convierte en una referencia opaca con HMAC y clave de red (ver
// ../src/patient.js, que explica por qué un SHA-256 pelado no alcanza).
function resolvePatientIDHash({ patientId, patientIDHash }) {
  if (patientIDHash) return patientIDHash;
  if (patientId) return patientRef(patientId);
  throw new Error('Falta patientId o patientIDHash');
}

async function emitAsset({ org, patientId, resourceType, resource }) {
  // Conformidad antes que criptografía: una vez cifrado y anclado, el recurso
  // queda inmutable y el error de origen se vuelve inmutable con él. Ver
  // ../src/conformance.js para por qué este orden no es intercambiable.
  const conformance = assertConformant(resourceType, resource);

  const patientIDHash = resolvePatientIDHash({ patientId });
  // El id se fija antes de cifrar: el blob se liga a la identidad del activo
  // (id + tipo + paciente) como AAD del GCM, así un ciphertext ajeno no
  // desenvuelve limpio aunque coincidiera el CID.
  const fhirResourceID = `${resourceType.toLowerCase()}-${Date.now()}`;
  const { blob, aesKey } = encryptResource(resource, assetAAD(fhirResourceID, resourceType, patientIDHash));
  const cid = await uploadToIPFS(blob, `${resourceType.toLowerCase()}.enc`);
  // El activo nace en el canal de la provincia del emisor (channelForOrgs de una
  // sola org = su canal jurisdiccional); asciende al nacional recién cuando un
  // consentimiento cruza una frontera (ver grantConsent).
  const channel = channelForOrgs(org);
  const { contract, mspId } = await getConn(org, channel);
  await contract.submitTransaction('EmitAsset', fhirResourceID, resourceType, cid, patientIDHash);

  rememberKey({
    aesKey,
    ownerOrgKey: org,
    ownerMspId: mspId,
    fhirResourceID,
    cid,
    resourceType,
    patientIDHash,
    channel,
  });

  // Las advertencias no bloquean la emisión pero viajan al emisor: son los
  // casos que el perfil liga con strength 'preferred' y que el estándar
  // tolera, como un código sin sistema terminológico declarado.
  return {
    fhirResourceID,
    cid,
    patientIDHash,
    ownerOrg: mspId,
    originChannel: channel,
    conformance: { ok: true, warnings: conformance.warnings },
  };
}

async function grantConsent({ org, grantedToOrg, patientId, patientIDHash, resourceTypes, expiry }) {
  const hash = resolvePatientIDHash({ patientId, patientIDHash });
  // grantedToOrg llega como MSP id desde la UI; el ruteo trabaja con org keys.
  const granteeKey = orgKeyForMsp(grantedToOrg) ?? grantedToOrg;
  const channel = channelForOrgs(org, granteeKey);
  const { contract, mspId: grantorMsp } = await getConn(org, channel);
  await contract.submitTransaction('GrantConsent', hash, grantedToOrg, JSON.stringify(resourceTypes), expiry);

  // Cross-jurisdiccional (el consentimiento se resolvió en el nacional): el
  // activo vive en el canal provincial del grantor y el grantee sólo comparte
  // el nacional, así que se asciende la REFERENCIA de cada activo del paciente
  // de esos tipos. Una tx no cruza canales: por eso son transacciones aparte.
  let ascended = 0;
  const provincial = channelForOrgs(org);
  if (channel === NATIONAL_CHANNEL && provincial !== NATIONAL_CHANNEL) {
    const assets = await evaluateJSONOn(org, provincial, 'GetAllAssets');
    const matching = assets.filter((a) =>
      a.PatientIDHash === hash
      && resourceTypes.includes(a.ResourceType)
      && a.OwnerOrg === grantorMsp);
    const { contract: nacional } = await getConn(org, NATIONAL_CHANNEL);
    for (const a of matching) {
      await nacional.submitTransaction('PublishAssetRef', a.FhirResourceID, a.ResourceType, a.IpfsCid, hash, provincial);
    }
    ascended = matching.length;
  }
  return { patientIDHash: hash, channel, ascended };
}

async function revokeConsent({ org, grantedToOrg, patientId, patientIDHash, resourceTypes }) {
  const hash = resolvePatientIDHash({ patientId, patientIDHash });
  const granteeKey = orgKeyForMsp(grantedToOrg) ?? grantedToOrg;
  const channel = channelForOrgs(org, granteeKey);
  const { contract } = await getConn(org, channel);
  await contract.submitTransaction('RevokeConsent', hash, grantedToOrg, JSON.stringify(resourceTypes || []));
  return { patientIDHash: hash, channel };
}

// checkAccess usa submitAsync (no submitTransaction) para conocer el txId y,
// tras el commit, leer el AccessLog de esa misma tx — así la respuesta trae el
// motivo del DENY además de la decisión.
//
// El acceso se pide por recurso concreto: el tipo y el paciente los deriva el
// chaincode del activo, así que no hace falta (ni conviene) mandarlos. La
// respuesta los devuelve leídos del AccessLog, que es lo que quedó auditado.
async function checkAccess({ org, fhirResourceID }) {
  if (!fhirResourceID) throw new Error('Falta fhirResourceID');

  // El acceso se evalúa en el canal donde el solicitante y el dueño se cruzan:
  // su provincia si la comparten, el nacional si no. Hay que saber de quién es
  // el activo antes de rutear, así que se resuelve en la unión de canales.
  const asset = await findAsset(fhirResourceID);
  const ownerKey = orgKeyForMsp(asset.OwnerOrg) ?? org;
  const channel = channelForOrgs(ownerKey, org);
  const { contract } = await getConn(org, channel);

  const commit = await contract.submitAsync('CheckAccess', { arguments: [fhirResourceID] });
  const decision = utf8(commit.getResult());
  const txId = commit.getTransactionId();

  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(`CheckAccess no se pudo commitear (tx ${txId}, código ${String(status.code)})`);
  }

  const log = await evaluateJSONOn(org, channel, 'GetAccessLog', txId);
  return {
    decision,
    reason: log.Reason,
    txId,
    fhirResourceID,
    resourceType: log.ResourceType,
    patientIDHash: log.PatientIDHash,
    channel,
  };
}

module.exports = { emitAsset, grantConsent, revokeConsent, checkAccess };
