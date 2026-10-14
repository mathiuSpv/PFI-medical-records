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

// computeCID calcula el CID que le correspondería a un contenido SIN
// almacenarlo (only-hash=true).
//
// Por qué se le pregunta al nodo en lugar de calcularlo acá: un CID no es el
// SHA-256 del archivo. Es un multihash sobre la estructura UnixFS/DAG que
// resulta de trocear el contenido, de modo que depende del tamaño de bloque,
// del codec y de la versión de CID con que se haya agregado. Recalcularlo con
// una implementación propia introduciría diferencias por parámetros y no por
// manipulación, que es justo lo contrario de lo que esta verificación busca
// detectar. Usando la misma ruta que produjo el CID original, una diferencia
// sólo puede significar que el contenido cambió.
async function computeCID(buffer, filename = 'resource.bin') {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);

  const res = await fetch(`${IPFS_API_URL}/api/v0/add?only-hash=true`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`IPFS add --only-hash falló: ${res.status} ${await res.text()}`);
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

module.exports = { uploadToIPFS, computeCID, downloadFromIPFS };
