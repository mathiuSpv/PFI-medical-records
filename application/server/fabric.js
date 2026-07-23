// Núcleo del BFF: conexiones Gateway por org, invocaciones al chaincode,
// listener de eventos, alta/baja de clínicas y estado en memoria del prototipo
// (keyStore de claves AES por recurso emitido desde la UI + deliveries de
// sobres envueltos). Reusa los módulos ya probados de ../src — acá no hay
// lógica de Fabric nueva, solo orquestación para exponerla por REST/SSE.
//
// Ninguna org está cableada: todo sale del registro de clínicas
// (network/organizations/clinics.json, vía ../src/config), así que un alta o
// una baja se reflejan sin reiniciar el server.
//
// Estado en memoria a propósito (prototipo): si el server se reinicia, las
// claves de los activos emitidos y los sobres se pierden (los metadatos on-
// chain e IPFS persisten). HSM/persistencia de claves está fuera de alcance
// de esta etapa (ver PLAN.md).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { common } = require('@hyperledger/fabric-protos');

const { newGatewayForOrg } = require('../src/connect');
const { listenForEvents } = require('../src/events');
const { encryptResource, decryptResource, wrapKeyForRecipient, unwrapKey } = require('../src/crypto');
const { uploadToIPFS, downloadFromIPFS } = require('../src/ipfs');
const {
  NETWORK_HOME,
  getOrgs,
  getAllOrgs,
  getChannels,
  orgKeyForMsp,
  paths,
  CHANNEL_NAME,
  CHAINCODE_NAME,
  IPFS_API_URL,
} = require('../src/config');

const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');

// ---------------------------------------------------------------------------
// Conexiones (lazy, cacheadas por org)
// ---------------------------------------------------------------------------

const connections = new Map();

async function getConn(orgKey) {
  const orgs = getOrgs();
  if (!orgs[orgKey]) {
    throw new Error(`Organización desconocida o dada de baja: ${orgKey}`);
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

// dropConn cierra y descarta la conexión de una org. Hace falta tras una baja:
// el peer se apaga y el Gateway cacheado quedaría reintentando contra un
// endpoint muerto.
async function dropConn(orgKey) {
  const pending = connections.get(orgKey);
  connections.delete(orgKey);
  if (!pending) return;
  try {
    const conn = await pending;
    conn.gateway.close();
    conn.client.close();
  } catch {
    // La conexión ya estaba rota: no hay nada que cerrar.
  }
}

async function evaluateJSON(orgKey, fn, ...args) {
  const { contract } = await getConn(orgKey);
  return JSON.parse(utf8(await contract.evaluateTransaction(fn, ...args)));
}

// defaultOrgKey — primera clínica activa. Se usa para las lecturas que no
// dependen de quién pregunta y para el listener de eventos.
function defaultOrgKey() {
  const keys = Object.keys(getOrgs());
  if (keys.length === 0) throw new Error('No hay clínicas activas en la red');
  return keys[0];
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

// ---------------------------------------------------------------------------
// Alta y baja de clínicas
// ---------------------------------------------------------------------------

// Mismo patrón que valida addOrg.sh, repetido acá para rechazar temprano y no
// llegar al script con basura. El key termina siendo nombre de host, de
// contenedor y de canal, así que no se acepta nada fuera de esto.
const KEY_RE = /^[a-z][a-z0-9]{2,15}$/;
const KEYS_RESERVADOS = new Set(['orderer', 'example', 'generated', 'all']);

function validarKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new Error('key inválido: minúsculas y dígitos, empieza con letra, 3-16 caracteres');
  }
  if (KEYS_RESERVADOS.has(key)) {
    throw new Error(`key reservado: ${key}`);
  }
  return key;
}

function validarTexto(valor, campo, max) {
  const texto = String(valor ?? '').trim();
  if (!texto) throw new Error(`${campo} es obligatorio`);
  if (texto.length > max) throw new Error(`${campo}: máximo ${max} caracteres`);
  if (/[\r\n]/.test(texto)) throw new Error(`${campo}: sin saltos de línea`);
  return texto;
}

// Dos regex y no una: con el flag /g, .test() es stateful (avanza lastIndex) y
// da falsos negativos alternados. La de test va sin /g a propósito.
const ANSI_G = /\x1b\[[0-9;]*m/g;
const ANSI_TEST = /\x1b\[[0-9;]*m/;

// runNetworkScript corre un script de network/scripts con spawn y los
// argumentos como ARRAY — nunca como string de shell. Es la única superficie
// del BFF que ejecuta procesos, y sus argumentos llegan por HTTP: sin shell de
// por medio no hay forma de que un valor se interprete como comando, y el key
// ya viene validado contra KEY_RE.
function runNetworkScript(script, args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [path.join(NETWORK_HOME, 'scripts', script), ...args], {
      cwd: NETWORK_HOME,
      env: { ...process.env, NETWORK_HOME },
    });

    const salida = [];
    const consumir = (chunk) => {
      for (const linea of chunk.toString().split('\n')) {
        // Los scripts narran su avance con infoln/successln/errorln, que
        // colorean la línea; todo lo demás es salida cruda de configtxgen,
        // cryptogen y peer. Se guarda todo (los errores del final salen de
        // ahí) pero al usuario solo se le manda la narración: si no, el
        // progreso son 200 líneas de INFO y no se entiende en qué paso va.
        const esNarracion = ANSI_TEST.test(linea);
        const limpia = linea.replace(ANSI_G, '').trimEnd();
        if (!limpia) continue;
        salida.push(limpia);
        if (esNarracion) onLine?.(limpia);
      }
    };

    proc.stdout.on('data', consumir);
    proc.stderr.on('data', consumir);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(salida);
      else reject(new Error(salida.slice(-3).join(' · ') || `${script} terminó con código ${code}`));
    });
  });
}

// esperarEstadoOnChain espera a que el registro del ledger refleje el estado
// esperado antes de responder. Hace falta porque `peer chaincode invoke` vuelve
// cuando junta las firmas de endorsement, no cuando el bloque commitea: sin
// esta espera, el listado que devuelve el alta muestra la clínica todavía sin
// registro on-chain y parece que RegisterClinic falló.
async function esperarEstadoOnChain(mspId, estadoEsperado, intentos = 8) {
  for (let i = 0; i < intentos; i++) {
    const clinicas = await listClinics();
    const objetivo = clinicas.find((c) => c.mspId === mspId);
    if (objetivo?.onChain?.estado === estadoEsperado) return clinicas;
    if (i < intentos - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  return listClinics();
}

// Una sola alta o baja a la vez: son actualizaciones de configuración del mismo
// canal, y dos en paralelo se pisan — la segunda computaría su delta contra un
// config que la primera ya cambió y el orderer la rechazaría por versión.
let operacionEnCurso = null;

async function conExclusion(descripcion, fn) {
  if (operacionEnCurso) {
    throw new Error(`Hay otra operación en curso: ${operacionEnCurso}`);
  }
  operacionEnCurso = descripcion;
  try {
    return await fn();
  } finally {
    operacionEnCurso = null;
  }
}

// addClinic da de alta una clínica de verdad: MSP nuevo, peer nuevo y
// actualización de config de canal-universal firmada por las existentes.
// Tarda ~40 s, así que va emitiendo el progreso por SSE.
async function addClinic({ key, nombre }, broadcast) {
  const k = validarKey(key);
  const n = validarTexto(nombre, 'nombre', 60);

  return conExclusion(`alta de ${k}`, async () => {
    broadcast?.({ type: 'clinic-op', op: 'alta', key: k, estado: 'en-curso', linea: `Dando de alta ${n}…` });
    try {
      await runNetworkScript('addOrg.sh', [k, n], (linea) =>
        broadcast?.({ type: 'clinic-op', op: 'alta', key: k, estado: 'en-curso', linea }),
      );
    } catch (err) {
      broadcast?.({ type: 'clinic-op', op: 'alta', key: k, estado: 'error', linea: err.message });
      throw err;
    }
    broadcast?.({ type: 'clinic-op', op: 'alta', key: k, estado: 'ok', linea: `${n} dada de alta` });
    const mspId = getAllOrgs()[k]?.mspId;
    return mspId ? esperarEstadoOnChain(mspId, 'ACTIVA') : listClinics();
  });
}

// removeClinic da de baja: revoca los consentimientos hacia esa org, asienta la
// baja on-chain, la saca de la config del canal y apaga su peer.
async function removeClinic({ key, motivo }, broadcast) {
  const k = validarKey(key);
  const m = validarTexto(motivo || 'baja solicitada', 'motivo', 200);

  return conExclusion(`baja de ${k}`, async () => {
    broadcast?.({ type: 'clinic-op', op: 'baja', key: k, estado: 'en-curso', linea: `Dando de baja ${k}…` });
    try {
      await runNetworkScript('removeOrg.sh', [k, m], (linea) =>
        broadcast?.({ type: 'clinic-op', op: 'baja', key: k, estado: 'en-curso', linea }),
      );
    } catch (err) {
      broadcast?.({ type: 'clinic-op', op: 'baja', key: k, estado: 'error', linea: err.message });
      throw err;
    }
    await dropConn(k);
    broadcast?.({ type: 'clinic-op', op: 'baja', key: k, estado: 'ok', linea: `${k} dada de baja` });
    const mspId = getAllOrgs()[k]?.mspId;
    return mspId ? esperarEstadoOnChain(mspId, 'BAJA') : listClinics();
  });
}

// listClinics cruza las tres vistas de la misma realidad: el registro local
// (puertos, nombres), el registro on-chain (estado auditable) y si el peer
// responde. Que las tres puedan discrepar es información, no ruido — por eso
// se devuelven separadas en vez de fusionarse en un solo booleano.
async function listClinics() {
  const locales = Object.values(getAllOrgs());

  let onChain = [];
  try {
    onChain = await evaluateJSON(defaultOrgKey(), 'GetAllClinics');
  } catch {
    // Sin red o sin chaincode todavía: se devuelve solo la vista local.
  }
  const porMsp = Object.fromEntries(onChain.map((c) => [c.MspID, c]));

  return Promise.all(
    locales.map(async (org) => {
      const salud = await probe(`http://127.0.0.1:${org.operationsPort}/healthz`);
      const registro = porMsp[org.mspId];
      return {
        ...org,
        peerOk: salud.ok,
        onChain: registro
          ? {
              estado: registro.Estado,
              registradaPor: registro.RegisteredByOrg,
              registradaEl: registro.RegisteredAt,
              bajaPor: registro.DeactivatedByOrg,
              bajaEl: registro.DeactivatedAt,
              motivoBaja: registro.MotivoBaja,
            }
          : null,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Listener de eventos (arranca en el boot del server)
// ---------------------------------------------------------------------------

// startEventListener escucha los eventos de chaincode del canal (una sola
// suscripción alcanza: canal-universal es público a todas las clínicas) y:
//  - AccessPermitted: lo emite por SSE y, si el keyStore tiene la clave del
//    recurso y el solicitante es otra org, envuelve la clave para el
//    certificado del solicitante y registra la entrega (simulada — sin envío
//    real entre orgs en esta etapa).
//  - ClinicRegistered / ClinicDeactivated: los reenvía para que la UI refresque
//    la topología sin hacer polling.
async function startEventListener(broadcast) {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let orgKey;
    try {
      orgKey = defaultOrgKey();
      const { network } = await getConn(orgKey);
      await listenForEvents(network, (event, payload) => {
        if (event.eventName === 'ClinicRegistered' || event.eventName === 'ClinicDeactivated') {
          broadcast({
            type: 'clinic-event',
            eventName: event.eventName,
            mspId: payload.MspID,
            nombre: payload.Nombre,
            estado: payload.Estado,
            txId: event.transactionId,
            blockNumber: String(event.blockNumber),
          });
          return;
        }

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
          recipientOrgKey: orgKeyForMsp(payload.RequesterOrg),
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
      console.log(`[fabric] Listener de eventos activo en '${CHANNEL_NAME}' (como ${orgKey})`);
      return;
    } catch (err) {
      console.warn(`[fabric] Listener no pudo arrancar (intento ${attempt}/${maxAttempts}): ${err.message}`);
      if (orgKey) await dropConn(orgKey);
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
  const orgs = Object.values(getOrgs());
  const [orderer, ipfs, ...peers] = await Promise.all([
    probe('http://127.0.0.1:9443/healthz'),
    probe(`${IPFS_API_URL}/api/v0/version`, { method: 'POST' }),
    ...orgs.map((org) => probe(`http://127.0.0.1:${org.operationsPort}/healthz`)),
  ]);

  return {
    orderer: { name: 'orderer.example.com', ok: orderer.ok },
    peers: Object.fromEntries(
      orgs.map((org, i) => [
        org.key,
        { name: `peer0.${org.domain}`, mspId: org.mspId, nombre: org.nombre, ok: peers[i].ok },
      ]),
    ),
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
  for (const channel of getChannels()) {
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
  getOrgs,
  getAllOrgs,
  defaultOrgKey,
  evaluateJSON,
  emitAsset,
  grantConsent,
  revokeConsent,
  checkAccess,
  decryptDelivery,
  deliveries,
  addClinic,
  removeClinic,
  listClinics,
  startEventListener,
  nodesStatus,
  channelsStatus,
};
