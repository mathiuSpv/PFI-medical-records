// Alta y baja de instituciones desde el dashboard.
//
// Es el único módulo del BFF que ejecuta procesos, y sus argumentos llegan por
// HTTP: por eso la validación vive acá al lado y los scripts se lanzan con
// spawn y argumentos como array, nunca por shell.
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { evaluateJSON, defaultOrgKey, dropConn } = require('./connections');
const { probe } = require('./health');
const { NETWORK_HOME, getAllOrgs } = require('../src/config');

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
// argumentos como ARRAY — nunca como string de shell. Sin shell de por medio no
// hay forma de que un valor se interprete como comando, y el key ya viene
// validado contra KEY_RE.
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

module.exports = { addClinic, removeClinic, listClinics };
