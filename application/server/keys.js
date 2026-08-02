// Claves AES de los recursos emitidos y entregas de clave.
//
// Estado en memoria a propósito (prototipo): si el server se reinicia, las
// claves y los sobres se pierden — los metadatos on-chain y el payload en IPFS
// persisten, pero sin la clave ese payload ya no se puede descifrar. HSM y
// persistencia de claves están fuera del alcance de esta etapa (ver PLAN.md).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { decryptResource, wrapKeyForRecipient, unwrapKey } = require('../src/crypto');
const { downloadFromIPFS } = require('../src/ipfs');
const { getAllOrgs, orgKeyForMsp, paths } = require('../src/config');

// keyStore: fhirResourceID -> { aesKey, ownerOrgKey, ... }
//
// Indexado por recurso, no por `${paciente}:${tipo}` como antes: con dos
// Observations del mismo paciente la clave de la segunda sobreescribía a la de
// la primera y la entrega podía terminar envolviendo la clave equivocada.
// El evento AccessPermitted trae el FhirResourceID, así que se puede resolver
// la clave exacta del recurso que se autorizó.
const keyStore = new Map();

// deliveries: sobres de clave envueltos tras cada PERMIT (nunca la clave en claro).
const deliveries = [];

// rememberKey guarda la clave de un recurso recién emitido desde la UI. Solo
// se recuerdan los emitidos por este proceso: de los que emitió otra instancia
// no tenemos la clave y el PERMIT no dispara entrega, que es lo correcto.
function rememberKey(entry) {
  keyStore.set(entry.fhirResourceID, entry);
}

// deliverKeyFor arma la entrega ante un PERMIT: envuelve la clave AES del
// recurso para el certificado del solicitante (ECDH P-256 + HKDF + AES-256-GCM)
// y la registra. Devuelve null si no hay nada que entregar — porque no tenemos
// la clave de ese recurso, o porque el solicitante es la propia org dueña.
function deliverKeyFor(payload) {
  const entry = keyStore.get(payload.FhirResourceID);
  if (!entry || payload.RequesterOrg === entry.ownerMspId) return null;

  const envelope = wrapKeyForRecipient(entry.aesKey, payload.RequesterCertPEM);
  const delivery = {
    id: crypto.randomUUID(),
    txId: payload.TxID,
    timestamp: new Date().toISOString(),
    fromOrg: entry.ownerMspId,
    toOrg: payload.RequesterOrg,
    recipientOrgKey: orgKeyForMsp(payload.RequesterOrg),
    recipientSubject: envelope.recipientSubject,
    fhirResourceID: entry.fhirResourceID,
    resourceType: entry.resourceType,
    patientIDHash: entry.patientIDHash,
    cid: entry.cid,
    envelope,
  };
  deliveries.push(delivery);
  return delivery;
}

async function decryptDelivery(deliveryId, orgKey) {
  const delivery = deliveries.find((d) => d.id === deliveryId);
  if (!delivery) {
    throw new Error(`No existe la entrega ${deliveryId}`);
  }
  const mspId = getAllOrgs()[orgKey]?.mspId;
  if (delivery.toOrg !== mspId) {
    throw new Error(`La entrega es para ${delivery.toOrg}, no para ${mspId}`);
  }

  // Acceso de archivo a la clave privada del destinatario: válido solo en
  // este entorno de desarrollo (mismo shortcut que demo.js — en despliegue
  // real esto correría en la instancia de la org destinataria).
  const cfg = paths(orgKey);
  const keyFiles = await fs.readdir(cfg.keyDirectoryPath);
  const privateKeyPem = await fs.readFile(path.join(cfg.keyDirectoryPath, keyFiles[0]));
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  const aesKey = unwrapKey(delivery.envelope, privateKey);
  const blob = await downloadFromIPFS(delivery.cid);
  const resource = decryptResource(blob, aesKey);
  return { resource, fhirResourceID: delivery.fhirResourceID, cid: delivery.cid };
}

module.exports = { deliveries, rememberKey, deliverKeyFor, decryptDelivery };
