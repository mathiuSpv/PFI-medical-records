# Plan de trabajo — Etapa 1

Prototipo punta a punta en entorno local: red Fabric 2 orgs + chaincode de consentimiento
ABAC + IPFS local + cliente de aplicación. Este archivo trackea el avance entre sesiones;
las decisiones de arquitectura (cerradas) están resumidas en el [README](README.md).

## Estado

| Paso | Descripción | Estado |
|------|-------------|--------|
| 0 | Devcontainer con dependencias Fabric | ✅ Completo |
| 1 | test-network de referencia funcionando | ✅ Completo |
| 2 | Red propia 2 orgs (clínica + laboratorio) | 🔄 En curso |
| 3 | Chaincode Go (consentimiento + ABAC) | ⬜ Pendiente |
| 4 | Nodo IPFS local (Kubo) | ⬜ Pendiente |
| 5 | Cliente de aplicación (Node.js) | ⬜ Pendiente |
| 6 | README de estudio completo | 🔄 Continuo (se actualiza en cada paso) |

## Paso 0 — Devcontainer

- [x] `devcontainer.json`: Ubuntu 22.04 + Docker-in-Docker + Go 1.23 + Node LTS
- [x] `post-create.sh`: jq, binarios Fabric 2.5.12 LTS, fabric-samples, imágenes Docker
- [x] `.gitattributes`: LF forzado en `.sh`/`.yaml` (evita `$'\r': command not found` al clonar desde Windows)
- [x] README: requisitos host macOS/Windows, cómo levantar el entorno
- [x] Verificar build completo del devcontainer (`devcontainer up`)
- [x] Verificar dentro del contenedor: `peer version`, `configtxgen --version`, `docker info`

Decisión: Docker-in-Docker (no socket del host) porque la test-network hace bind mounts
de rutas que solo existen dentro del devcontainer.

## Paso 1 — test-network de referencia

- [x] `./network.sh up createChannel` sin errores (2 orgs + orderer Raft + canal `mychannel`)
- [x] `./network.sh deployCC` con chaincode de ejemplo Go (asset-transfer-basic)
- [x] Invoke + query manuales con el CLI `peer` (entender los `export` de identidad MSP/TLS)
- [x] `./network.sh down` limpio

Objetivo: entorno de referencia validado + material de estudio de la anatomía de una red
Fabric antes de armar la propia.

Incidente resuelto (ver README § Troubleshooting): `peer lifecycle chaincode install`
fallaba con `docker image build failed: write unix @->/var/run/docker.sock: write:
broken pipe`. Causa: el chaincode builder legacy de Fabric 2.5 es incompatible con
Docker/Moby ≥ 25 (la feature del devcontainer traía `29.6.1` con `version: "latest"`).
Fix: pinear `ghcr.io/devcontainers/features/docker-in-docker` a `"version": "24"` en
`devcontainer.json` (ya aplicado). Requiere rebuild del devcontainer para quedar limpio;
esta sesión se resolvió en caliente con `apt-get install --allow-downgrades
moby-engine=24.0.9-ubuntu22.04u2` + reinicio de `dockerd`.

## Paso 2 — Red propia (`network/`)

- [ ] Material criptográfico para ClinicaMSP y LaboratorioMSP (cryptogen primero; CA real después si da el tiempo)
- [ ] `configtx.yaml` propio: 2 orgs + orderer Raft compartido, perfiles para cada canal
- [ ] `docker-compose` con: orderer, peer0.clinica, peer0.laboratorio
- [ ] Canal público `canal-universal` (ambas orgs)
- [ ] Canal privado `canal-clinica` (solo clínica como miembro de aplicación + orderer compartido)
- [ ] Scripts de levantado/bajado documentados

## Paso 3 — Chaincode Go (`chaincode/`)

- [ ] `EmitAsset(fhir_resource_id, resource_type, ipfs_cid, patient_id_hash)` — registra metadatos; NO toca IPFS
- [ ] `GrantConsent(patient_id_hash, org, resource_types[], expiry)` — deny por defecto, mínimo privilegio
- [ ] `RevokeConsent` — total o parcial, historial inmutable
- [ ] `CheckAccess(requester_org, resource_type, patient_id_hash)` — ABAC: consentimiento vigente + scope + expiry; registra PERMIT/DENY en ledger (auditoría con tx_id, timestamp, requester_org, resource_type)
- [ ] Evento de chaincode ante PERMIT (para que la app emisora dispare entrega de clave)
- [ ] Restricción: determinista, sin llamadas de red, solo ChaincodeStub
- [ ] Desplegado en `canal-universal`, probado con CLI `peer`

## Paso 4 — IPFS local (`docker-compose` en `network/` o propio)

- [ ] Kubo en Docker, un solo nodo, API en :5001
- [ ] Verificar add/cat por API

## Paso 5 — Cliente de aplicación (`application/`)

Node.js + `@hyperledger/fabric-gateway` (decidido: chaincode ya es Go; Node separa
"dentro/fuera del ledger", Gateway SDK Node es el más documentado para apps, listener de
eventos + HTTP entre orgs con menos ceremonia).

- [ ] Cifrar JSON de ejemplo con AES-256-GCM
- [ ] Subir a IPFS local, obtener CID
- [ ] Invocar `EmitAsset` con el CID
- [ ] Flujo completo simulado: solicitud de acceso → `GrantConsent` → `CheckAccess` → evento PERMIT → entrega de clave (log simulado en esta etapa)
- [ ] Listener de eventos de chaincode por org

## Fuera de alcance (etapa 1)

IPFS distribuido/pinning externo, modelado FHIR completo, HSM/gestión avanzada de claves.

## Etapas futuras (solo referencia, no implementar aún)

- Modelado FHIR R4 real de recursos
- Entrega de clave por HTTP/mTLS real entre orgs (hoy: log simulado)
- Múltiples nodos IPFS / pinning
- Evaluación empírica (métricas de latencia/throughput para la tesis)
