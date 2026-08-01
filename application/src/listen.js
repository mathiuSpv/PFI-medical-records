// Listener de eventos de chaincode standalone, por org — corre en su propia
// terminal y se queda escuchando AccessPermitted en canal-universal hasta
// Ctrl+C. Uso: node src/listen.js <sancristobal|montenegro>
'use strict';

const { newGatewayForOrg } = require('./connect');
const { listenForEvents } = require('./events');
const { CHANNEL_NAME } = require('./config');

async function main() {
  const orgKey = process.argv[2];
  if (orgKey !== 'sancristobal' && orgKey !== 'montenegro') {
    console.error('Uso: node src/listen.js <sancristobal|montenegro>');
    process.exitCode = 1;
    return;
  }

  const { gateway, client, mspId } = await newGatewayForOrg(orgKey);
  console.log(`[${mspId}] Conectado. Escuchando eventos de chaincode en '${CHANNEL_NAME}'... (Ctrl+C para salir)`);

  const network = gateway.getNetwork(CHANNEL_NAME);
  const { events, done } = await listenForEvents(network, (event, payload) => {
    console.log(`\n<-- [${mspId}] Evento '${event.eventName}' (tx ${event.transactionId}, bloque ${event.blockNumber})`);
    console.log(JSON.stringify(payload, null, 2));
  });

  const shutdown = () => {
    console.log(`\n[${mspId}] Cerrando listener...`);
    events.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await done;
  } finally {
    gateway.close();
    client.close();
  }
}

main().catch((error) => {
  console.error('******** FAILED:', error);
  process.exitCode = 1;
});
