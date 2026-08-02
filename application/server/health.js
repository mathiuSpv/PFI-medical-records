// Estado de la infraestructura: sondas a los endpoints de operaciones de los
// nodos y altura de cada canal.
'use strict';

const { common } = require('@hyperledger/fabric-protos');

const { getConn } = require('./connections');
const { getOrgs, getChannels, IPFS_API_URL } = require('../src/config');

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

module.exports = { probe, nodesStatus, channelsStatus };
