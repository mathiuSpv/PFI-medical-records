// Las cuatro operaciones del bus, expuestas al dashboard: emitir un activo,
// otorgar y revocar consentimiento, y pedir acceso. Acá no hay lógica de Fabric
// nueva — es orquestación sobre los módulos ya probados de ../src.
'use strict';

const { getConn, evaluateJSON, utf8 } = require('./connections');
const { rememberKey } = require('./keys');
const { encryptResource } = require('../src/crypto');
const { uploadToIPFS } = require('../src/ipfs');
const { patientRef } = require('../src/patient');

// El identificador del paciente nunca sale de acá en claro ni como hash simple:
// se convierte en una referencia opaca con HMAC y clave de red (ver
// ../src/patient.js, que explica por qué un SHA-256 pelado no alcanza).
function resolvePatientIDHash({ patientId, patientIDHash }) {
  if (patientIDHash) return patientIDHash;
  if (patientId) return patientRef(patientId);
  throw new Error('Falta patientId o patientIDHash');
}

async function emitAsset({ org, patientId, resourceType, resource }) {
  const patientIDHash = resolvePatientIDHash({ patientId });
  const { blob, aesKey } = encryptResource(resource);
  const cid = await uploadToIPFS(blob, `${resourceType.toLowerCase()}.enc`);

  const fhirResourceID = `${resourceType.toLowerCase()}-${Date.now()}`;
  const { contract, mspId } = await getConn(org);
  await contract.submitTransaction('EmitAsset', fhirResourceID, resourceType, cid, patientIDHash);

  rememberKey({
    aesKey,
    ownerOrgKey: org,
    ownerMspId: mspId,
    fhirResourceID,
    cid,
    resourceType,
    patientIDHash,
  });

  return { fhirResourceID, cid, patientIDHash, ownerOrg: mspId };
}

async function grantConsent({ org, grantedToOrg, patientId, patientIDHash, resourceTypes, expiry }) {
  const hash = resolvePatientIDHash({ patientId, patientIDHash });
  const { contract } = await getConn(org);
  await contract.submitTransaction('GrantConsent', hash, grantedToOrg, JSON.stringify(resourceTypes), expiry);
  return { patientIDHash: hash };
}

async function revokeConsent({ org, grantedToOrg, patientId, patientIDHash, resourceTypes }) {
  const hash = resolvePatientIDHash({ patientId, patientIDHash });
  const { contract } = await getConn(org);
  await contract.submitTransaction('RevokeConsent', hash, grantedToOrg, JSON.stringify(resourceTypes || []));
  return { patientIDHash: hash };
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
  const { contract } = await getConn(org);

  const commit = await contract.submitAsync('CheckAccess', { arguments: [fhirResourceID] });
  const decision = utf8(commit.getResult());
  const txId = commit.getTransactionId();

  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(`CheckAccess no se pudo commitear (tx ${txId}, código ${String(status.code)})`);
  }

  const log = await evaluateJSON(org, 'GetAccessLog', txId);
  return {
    decision,
    reason: log.Reason,
    txId,
    fhirResourceID,
    resourceType: log.ResourceType,
    patientIDHash: log.PatientIDHash,
  };
}

module.exports = { emitAsset, grantConsent, revokeConsent, checkAccess };
