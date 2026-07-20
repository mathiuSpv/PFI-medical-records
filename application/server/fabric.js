// Núcleo del BFF: conexiones Gateway por org, invocaciones al chaincode,
// listener de eventos y estado en memoria del prototipo (keyStore de claves
// AES por recurso emitido desde la UI + deliveries de sobres envueltos).
// Reusa los módulos ya probados de ../src — acá no hay lógica de Fabric
// nueva, solo orquestación para exponerla por REST/SSE.
//
// Estado en memoria a propósito (prototipo): si el server se reinicia, las
// claves de los activos emitidos y los sobres se pierden (los metadatos on-
// chain e IPFS persisten). HSM/persistencia de claves está fuera de alcance
// de esta etapa (ver PLAN.md).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { common } = require('@hyperledger/fabric-protos');

const { newGatewayForOrg } = require('../src/connect');
const { listenForEvents } = require('../src/events');
const { encryptResource, decryptResource, wrapKeyForRecipient, unwrapKey } = require('../src/crypto');
const { uploadToIPFS, downloadFromIPFS } = require('../src/ipfs');
const { ORGS, paths, CHANNEL_NAME, CHAINCODE_NAME, IPFS_API_URL } = require('../src/config');

const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');

const ALL_CHANNELS = ['canal-universal', 'canal-sancristobal', 'canal-montenegro'];

const mspIdToOrgKey = Object.fromEntries(
  Object.entries(ORGS).map(([key, org]) => [org.mspId, key]),
);

// ---------------------------------------------------------------------------
// Conexiones (lazy, cacheadas por org)
// ---------------------------------------------------------------------------

const connections = new Map();

async function getConn(orgKey) {
  if (!ORGS[orgKey]) {
    throw new Error(`Organización desconocida: ${orgKey}`);
  }
  if (!connections.has(orgKey)) {
    connections.set(orgKey, (async () => {
      const { gateway, client, mspId } = await newGatewayForOrg(orgKey);
      const network = gateway.getNetwork(CHANNEL_NAME);
      const contract = network.getContract(CHAINCODE_NAME);
      return { gateway, client, mspId, network, contract };
    })());
  }
  return connections.get(orgKey);
}

async function evaluateJSON(orgKey, fn, ...args) {
  const { contract } = await getConn(orgKey);
  return JSON.parse(utf8(await contract.evaluateTransaction(fn, ...args)));
}

// ---------------------------------------------------------------------------
// Estado en memoria del prototipo
// ---------------------------------------------------------------------------

// keyStore: `${patientIDHash}:${resourceType}` -> { aesKey, ownerOrgKey, ... }
// (mismo índice compuesto que usa el evento AccessPermitted para resolver
// qué clave entregar — el evento no trae el fhirResourceID).
const keyStore = new Map();

// deliveries: sobres de clave envueltos tras cada PERMIT (sin la clave en claro).
const deliveries = [];

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

function resolvePatientIDHash({ patientId, patientIDHash }) {
  if (patientIDHash) return patientIDHash;
  if (patientId) return crypto.createHash('sha256').update(patientId).digest('hex');
  throw new Error('Falta patientId o patientIDHash');
}

async function emitAsset({ org, patientId, resourceType, resource }) {
  const patientIDHash = resolvePatientIDHash({ patientId });
  const { blob, aesKey } = encryptResource(resource);
  const cid = await uploadToIPFS(blob, `${resourceType.toLowerCase()}.enc`);

  const fhirResourceID = `${resourceType.toLowerCase()}-${Date.now()}`;
  const { contract, mspId } = await getConn(org);
  await contract.submitTransaction('EmitAsset', fhirResourceID, resourceType, cid, patientIDHash);

  keyStore.set(`${patientIDHash}:${resourceType}`, {
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
// tras el commit, leer el AccessLog de esa misma tx — así la respuesta trae
// el motivo del DENY además de la decisión.
async function checkAccess({ org, resourceType, patientId, patientIDHash }) {
  const hash = resolvePatientIDHash({ patientId, patientIDHash });
  const { contract } = await getConn(org);

  const commit = await contract.submitAsync('CheckAccess', { arguments: [resourceType, hash] });
  const decision = utf8(commit.getResult());
  const txId = commit.getTransactionId();

  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(`CheckAccess no se pudo commitear (tx ${txId}, código ${String(status.code)})`);
  }

  const log = await evaluateJSON(org, 'GetAccessLog', txId);
  return { decision, reason: log.Reason, txId, patientIDHash: hash };
}

async function decryptDelivery(deliveryId, orgKey) {
  const delivery = deliveries.find((d) => d.id === deliveryId);
  if (!delivery) {
    throw new Error(`No existe la entrega ${deliveryId}`);
  }
  const mspId = ORGS[orgKey]?.mspId;
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

// ---------------------------------------------------------------------------
// Listener de eventos (arranca en el boot del server)
// ---------------------------------------------------------------------------

// startEventListener escucha los eventos de chaincode del canal (una sola
// suscripción alcanza: canal-universal es público a ambas orgs) y ante cada
// AccessPermitted: lo emite por SSE y, si el keyStore tiene la clave del
// recurso y el solicitante es otra org, envuelve la clave para el
// certificado del solicitante y registra la entrega (simulada — sin envío
// real entre orgs en esta etapa).
async function startEventListener(broadcast) {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { network } = await getConn('sancristobal');
      await listenForEvents(network, (event, payload) => {
        if (event.eventName !== 'AccessPermitted') return;

        broadcast({
          type: 'chaincode-event',
          eventName: event.eventName,
          txId: payload.TxID,
          blockNumber: String(event.blockNumber),
          requesterOrg: payload.RequesterOrg,
          resourceType: payload.ResourceType,
          patientIDHash: payload.PatientIDHash,
          timestamp: payload.Timestamp,
        });

        const entry = keyStore.get(`${payload.PatientIDHash}:${payload.ResourceType}`);
        if (!entry || payload.RequesterOrg === entry.ownerMspId) return;

        const envelope = wrapKeyForRecipient(entry.aesKey, payload.RequesterCertPEM);
        const delivery = {
          id: crypto.randomUUID(),
          txId: payload.TxID,
          timestamp: new Date().toISOString(),
          fromOrg: entry.ownerMspId,
          toOrg: payload.RequesterOrg,
          recipientOrgKey: mspIdToOrgKey[payload.RequesterOrg],
          recipientSubject: envelope.recipientSubject,
          fhirResourceID: entry.fhirResourceID,
          resourceType: entry.resourceType,
          patientIDHash: entry.patientIDHash,
          cid: entry.cid,
          envelope,
        };
        deliveries.push(delivery);
        broadcast({ type: 'key-delivery', delivery });
      });
      console.log(`[fabric] Listener de eventos activo en '${CHANNEL_NAME}'`);
      return;
    } catch (err) {
      console.warn(`[fabric] Listener no pudo arrancar (intento ${attempt}/${maxAttempts}): ${err.message}`);
      connections.delete('sancristobal');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.error('[fabric] El listener de eventos no pudo arrancar; ¿está la red levantada? Reiniciar el server tras levantar la red.');
}

// ---------------------------------------------------------------------------
// Estado de nodos y canales
// ---------------------------------------------------------------------------

async function probe(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: await res.text() };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function nodesStatus() {
  const [orderer, peerSC, peerM, ipfs] = await Promise.all([
    probe('http://127.0.0.1:9443/healthz'),
    probe('http://127.0.0.1:9444/healthz'),
    probe('http://127.0.0.1:9445/healthz'),
    probe(`${IPFS_API_URL}/api/v0/version`, { method: 'POST' }),
  ]);
  return {
    orderer: { name: 'orderer.example.com', ok: orderer.ok },
    peers: {
      sancristobal: { name: 'peer0.sancristobal.example.com', mspId: ORGS.sancristobal.mspId, ok: peerSC.ok },
      montenegro: { name: 'peer0.montenegro.example.com', mspId: ORGS.montenegro.mspId, ok: peerM.ok },
    },
    ipfs: { name: 'ipfs (Kubo)', ok: ipfs.ok, version: ipfs.ok ? JSON.parse(ipfs.detail).Version : null },
  };
}

// channelsStatus consulta la altura de cada canal vía qscc GetChainInfo con
// la identidad de la org indicada. Los canales privados ajenos fallan en el
// peer (no es miembro) → se reportan como sinAcceso: el aislamiento del
// diseño, visible en la UI.
async function channelsStatus(orgKey) {
  const { gateway } = await getConn(orgKey);
  const out = [];
  for (const channel of ALL_CHANNELS) {
    try {
      const qscc = gateway.getNetwork(channel).getContract('qscc');
      const infoBytes = await qscc.evaluateTransaction('GetChainInfo', channel);
      const info = common.BlockchainInfo.deserializeBinary(infoBytes);
      out.push({ name: channel, height: Number(info.getHeight()), sinAcceso: false });
    } catch {
      out.push({ name: channel, height: null, sinAcceso: true });
    }
  }
  return out;
}

module.exports = {
  ORGS,
  evaluateJSON,
  emitAsset,
  grantConsent,
  revokeConsent,
  checkAccess,
  decryptDelivery,
  deliveries,
  startEventListener,
  nodesStatus,
  channelsStatus,
};
