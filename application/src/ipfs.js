// Cliente mínimo de la API HTTP de Kubo (network/network.sh ipfsUp). Node
// trae fetch/FormData/Blob globales desde la v18, no hace falta un cliente
// de IPFS aparte.
'use strict';

const { IPFS_API_URL } = require('./config');

async function uploadToIPFS(buffer, filename = 'resource.bin') {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);

  const res = await fetch(`${IPFS_API_URL}/api/v0/add`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`IPFS add falló: ${res.status} ${await res.text()}`);
  }
  const { Hash: cid } = await res.json();
  return cid;
}

async function downloadFromIPFS(cid) {
  const res = await fetch(`${IPFS_API_URL}/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`IPFS cat falló: ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { uploadToIPFS, downloadFromIPFS };
