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

const { decryptResource, wrapKeyForRecipient, unwrapKey, assetAAD, keyWrapAAD } = require('../src/crypto');
const { downloadFromIPFS, computeCID } = require('../src/ipfs');
const { verifyAgainstLedger } = require('../src/integrity');
const { findAsset, allAssets } = require('./readmodel');
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

// --- Persistencia con cifrado en reposo --------------------------------------
// Las claves AES y los sobres viven bajo PFI_DATA_DIR (por defecto
// application/.data/, gitignoreado) para que sobrevivan a un reinicio del
// server mientras la red Fabric sigue arriba. El archivo se CIFRA en reposo con
// AES-256-GCM: una lectura del disco ya no entrega las claves en claro. La clave
// maestra se deriva (scrypt) de PFI_KEYSTORE_SECRET; sin esa variable se usa una
// clave de DESARROLLO (no secreta) y se avisa — en prod hay que setearla. No es
// un HSM: la clave maestra sigue viviendo en el entorno, pero cierra el agujero
// de las claves en texto plano en disco.
const DATA_DIR = process.env.PFI_DATA_DIR || path.join(__dirname, '..', '.data');
const STATE_FILE = path.join(DATA_DIR, 'keystore.json');

let masterKey;
function keystoreKey() {
  if (masterKey) return masterKey;
  const secret = process.env.PFI_KEYSTORE_SECRET;
  if (!secret) {
    console.warn('[keys] PFI_KEYSTORE_SECRET no seteado: el keystore en disco se cifra con una clave de DESARROLLO (no secreta). Setear la variable en despliegue real.');
  }
  masterKey = crypto.scryptSync(secret || 'pfi-dev-keystore-no-secreto', 'pfi-keystore-at-rest-v1', 32);
  return masterKey;
}

function serializeState() {
  return JSON.stringify({
    version: 1,
    keys: [...keyStore.values()].map((e) => ({ ...e, aesKey: e.aesKey.toString('base64') })),
    deliveries,
  });
}

// encryptState: envuelve el JSON del estado en AES-256-GCM (iv || tag || ct).
function encryptState(jsonStr) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keystoreKey(), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(jsonStr, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, enc: Buffer.concat([iv, tag, ct]).toString('base64') });
}

// decryptState: descifra el archivo; tolera el formato viejo en claro (sin
// campo `enc`) para no perder un keystore anterior a esta versión.
function decryptState(fileStr) {
  const parsed = JSON.parse(fileStr);
  if (!parsed.enc) return parsed;
  const blob = Buffer.from(parsed.enc, 'base64');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', keystoreKey(), iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// Escritura serializada (cola de una sola corrida) y atómica (tmp + rename):
// un reinicio en mitad de un write no deja el archivo a medias.
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, encryptState(serializeState()));
      await fs.rename(tmp, STATE_FILE);
    })
    .catch((err) => console.error('[keys] no se pudo persistir el keystore:', err.message));
  return writeChain;
}

// loadState rehidrata keyStore y deliveries EN SU LUGAR: routes.js exporta
// `deliveries` por referencia, así que se vacía y se vuelve a llenar el mismo
// array, no se reasigna. Tolerante a archivo ausente (primer arranque) o
// corrupto (se ignora y arranca vacío).
async function loadState() {
  let raw;
  try {
    raw = await fs.readFile(STATE_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { keys: 0, deliveries: 0 };
    throw err;
  }
  let data;
  try {
    data = decryptState(raw);
  } catch {
    console.error('[keys] keystore.json ilegible o clave maestra equivocada, se arranca vacío');
    return { keys: 0, deliveries: 0 };
  }
  keyStore.clear();
  deliveries.length = 0;
  for (const e of data.keys || []) {
    keyStore.set(e.fhirResourceID, { ...e, aesKey: Buffer.from(e.aesKey, 'base64') });
  }
  for (const d of data.deliveries || []) deliveries.push(d);
  return { keys: keyStore.size, deliveries: deliveries.length };
}

// rememberKey guarda la clave de un recurso recién emitido desde la UI. Solo
// se recuerdan los emitidos por este proceso: de los que emitió otra instancia
// no tenemos la clave y el PERMIT no dispara entrega, que es lo correcto.
function rememberKey(entry) {
  keyStore.set(entry.fhirResourceID, entry);
  persist();
}

// deliverKeyFor arma la entrega ante un PERMIT: envuelve la clave AES del
// recurso para el certificado del solicitante (ECDH P-256 + HKDF + AES-256-GCM)
// y la registra. Devuelve null si no hay nada que entregar — porque no tenemos
// la clave de ese recurso, o porque el solicitante es la propia org dueña.
function deliverKeyFor(payload) {
  const entry = keyStore.get(payload.FhirResourceID);
  if (!entry || payload.RequesterOrg === entry.ownerMspId) return null;

  const envelope = wrapKeyForRecipient(entry.aesKey, payload.RequesterCertPEM, keyWrapAAD(payload.FhirResourceID));
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
  persist();
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

  const aesKey = unwrapKey(delivery.envelope, privateKey, keyWrapAAD(delivery.fhirResourceID));
  const blob = await downloadFromIPFS(delivery.cid);

  // Integridad antes que descifrado: el ledger es la autoridad sobre qué CID
  // le corresponde al activo, y la entrega es estado local del servidor. Si se
  // descifrara primero, un contenido cifrado válido pero ajeno al activo
  // pasaría el control de AES-GCM sin que nadie lo note.
  const asset = await findAsset(delivery.fhirResourceID);
  const integridad = await verifyAgainstLedger({
    asset,
    cidUsado: delivery.cid,
    blob,
    computeCID,
  });

  const resource = decryptResource(blob, aesKey, assetAAD(delivery.fhirResourceID, delivery.resourceType, delivery.patientIDHash));
  return {
    resource,
    fhirResourceID: delivery.fhirResourceID,
    cid: delivery.cid,
    integridad,
  };
}

// verifyAssetIntegrity descarga el contenido de un activo y lo contrasta con
// la referencia anclada en la cadena, sin descifrarlo. No necesita la clave
// AES: la integridad se verifica sobre el blob cifrado, que es exactamente lo
// que el CID identifica.
async function verifyAssetIntegrity(fhirResourceID, orgKey) {
  const asset = await findAsset(fhirResourceID);
  const blob = await downloadFromIPFS(asset.IpfsCid);
  const integridad = await verifyAgainstLedger({
    asset,
    cidUsado: asset.IpfsCid,
    blob,
    computeCID,
  });
  return {
    fhirResourceID,
    cidEnLedger: asset.IpfsCid,
    bytes: blob.length,
    ...integridad,
  };
}

// auditIntegrity recorre TODOS los activos de la unión de canales y verifica la
// integridad de cada uno contra el CID anclado. Es la auditoría periódica/bajo
// demanda que la verificación on-demand (sólo al descifrar) no cubría: detecta
// un blob caído o mutado en IPFS antes de que alguien lo pida. Un activo que
// falla no corta el barrido: se registra y se sigue.
async function auditIntegrity() {
  const assets = await allAssets();
  const resultados = [];
  for (const a of assets) {
    try {
      const r = await verifyAssetIntegrity(a.FhirResourceID);
      resultados.push({ fhirResourceID: a.FhirResourceID, ok: r.ok !== false });
    } catch (err) {
      resultados.push({ fhirResourceID: a.FhirResourceID, ok: false, error: err.message });
    }
  }
  const failed = resultados.filter((r) => !r.ok);
  return { checked: resultados.length, ok: resultados.length - failed.length, failed };
}

module.exports = {
  deliveries,
  loadState,
  auditIntegrity,
  rememberKey,
  deliverKeyFor,
  decryptDelivery,
  verifyAssetIntegrity,
};
