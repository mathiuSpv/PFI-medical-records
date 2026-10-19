// BFF del dashboard web (paso extra post-etapa-1): expone por REST + SSE la
// capa de aplicación del paso 5 para que el frontend React (application/web)
// pueda operar la red sin hablar gRPC. Requiere la red Fabric + IPFS
// levantados (network/network.sh). Puerto 3001 (env PORT para cambiarlo).
'use strict';

const express = require('express');
const buildRoutes = require('./routes');
const { startEventListener } = require('./listener');
const { loadState, auditIntegrity } = require('./keys');

const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- SSE hub -----------------------------------------------------------------
const sseClients = new Set();

function broadcast(obj) {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    res.write(frame);
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': conectado\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Heartbeat: mantiene vivas las conexiones SSE a través de proxies (Vite,
// port-forward de VS Code) que cierran streams inactivos.
setInterval(() => {
  for (const res of sseClients) {
    res.write(': ping\n\n');
  }
}, 15000).unref();

// --- REST --------------------------------------------------------------------
// El router recibe broadcast: el alta y la baja de clínicas informan su avance
// por SSE mientras corren.
app.use('/api', buildRoutes(broadcast));

app.listen(PORT, async () => {
  console.log(`[server] BFF escuchando en http://localhost:${PORT}`);
  console.log('[server] Requiere red Fabric + IPFS arriba (network/network.sh up|createChannels|deployCC|ipfsUp)');
  try {
    const s = await loadState();
    console.log(`[server] keystore restaurado: ${s.keys} claves, ${s.deliveries} entregas`);
  } catch (err) {
    console.error('[server] no se pudo restaurar el keystore:', err.message);
  }
  void startEventListener(broadcast);

  // Auditoría periódica de integridad (opt-in por env, en ms): barre todos los
  // activos y avisa por consola si alguno no coincide con su CID anclado. Apagada
  // por defecto para no pegarle a IPFS sin pedirlo.
  const auditMs = Number(process.env.PFI_AUDIT_INTERVAL_MS || 0);
  if (auditMs > 0) {
    console.log(`[server] auditoría de integridad periódica cada ${auditMs} ms`);
    setInterval(async () => {
      try {
        const r = await auditIntegrity();
        if (r.failed.length) console.error(`[audit] integridad: ${r.failed.length}/${r.checked} FALLARON`, r.failed);
        else console.log(`[audit] integridad OK (${r.checked} activos)`);
      } catch (err) {
        console.error('[audit] no se pudo correr la auditoría:', err.message);
      }
    }, auditMs).unref();
  }
});
