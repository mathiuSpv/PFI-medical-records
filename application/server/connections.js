// Conexiones Gateway por organización: caché perezosa, invalidación y las dos
// lecturas genéricas que usa todo el resto del BFF.
//
// Ninguna org está cableada: salen del registro de clínicas (vía ../src/config),
// así que un alta o una baja se reflejan sin reiniciar el server.
'use strict';

const { newGatewayForOrg } = require('../src/connect');
const { getOrgs, NATIONAL_CHANNEL, CHAINCODE_NAME } = require('../src/config');

const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');

const connections = new Map();

// La caché es por (org, canal) y no por org: con la topología jerárquica una
// misma institución opera en su canal jurisdiccional y en el nacional, y cada
// uno es una red distinta para el Gateway. Sin el canal en la clave, la primera
// conexión que se abriera fijaría el canal para todas las operaciones de esa
// org.
const connKey = (orgKey, channel) => `${orgKey}|${channel}`;

async function getConn(orgKey, channel = NATIONAL_CHANNEL) {
  const orgs = getOrgs();
  if (!orgs[orgKey]) {
    throw new Error(`Organización desconocida o dada de baja: ${orgKey}`);
  }
  const key = connKey(orgKey, channel);
  if (!connections.has(key)) {
    connections.set(key, (async () => {
      const { gateway, client, mspId } = await newGatewayForOrg(orgKey);
      const network = gateway.getNetwork(channel);
      const contract = network.getContract(CHAINCODE_NAME);
      return { gateway, client, mspId, network, contract, channel };
    })());
  }
  return connections.get(key);
}

// dropConn cierra y descarta la conexión de una org. Hace falta tras una baja:
// el peer se apaga y el Gateway cacheado quedaría reintentando contra un
// endpoint muerto.
// Cierra TODAS las conexiones de la org, en todos los canales en los que
// hubiera abierto alguna: tras una baja su peer se apaga y cualquiera de ellas
// quedaría reintentando contra un endpoint muerto.
async function dropConn(orgKey) {
  const propias = [...connections.keys()].filter((k) => k.startsWith(`${orgKey}|`));
  await Promise.all(propias.map(async (key) => {
    const pending = connections.get(key);
    connections.delete(key);
    if (!pending) return;
    try {
      const conn = await pending;
      conn.gateway.close();
      conn.client.close();
    } catch {
      // La conexión ya estaba rota: no hay nada que cerrar.
    }
  }));
}

async function evaluateJSON(orgKey, fn, ...args) {
  const { contract } = await getConn(orgKey, NATIONAL_CHANNEL);
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
