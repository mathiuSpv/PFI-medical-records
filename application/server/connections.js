// Conexiones Gateway por organización: caché perezosa, invalidación y las dos
// lecturas genéricas que usa todo el resto del BFF.
//
// Ninguna org está cableada: salen del registro de clínicas (vía ../src/config),
// así que un alta o una baja se reflejan sin reiniciar el server.
'use strict';

const { newGatewayForOrg } = require('../src/connect');
const { getOrgs, CHANNEL_NAME, CHAINCODE_NAME } = require('../src/config');

const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');

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

module.exports = { utf8, getConn, dropConn, evaluateJSON, defaultOrgKey };
