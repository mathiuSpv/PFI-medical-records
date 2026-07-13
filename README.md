# PFI — Bus de interoperabilidad descentralizado para activos médicos digitales

Prototipo de tesis (UADE): intercambio seguro de recursos HL7 FHIR R4 entre instituciones
de salud sobre **Hyperledger Fabric** (control de acceso, consentimiento, auditoría) e
**IPFS** (almacenamiento del payload clínico cifrado).

## Arquitectura (resumen)

Orgs de ejemplo (prototipo): **Clínica San Cristóbal** (`ClinicaSanCristobalMSP`) y
**Clínica Montenegro** (`ClinicaMontenegroMSP`), dos instituciones de salud
intercambiando recursos entre sí sobre la misma red.

- **Canal público (`canal-universal`)**: todas las orgs. Solo metadatos en claro
  (`fhir_resource_id`, `resource_type`, `ipfs_cid`, `patient_id_hash`, firma, timestamp).
  Nunca contiene payload clínico.
- **Canal privado por org (`canal-sancristobal`, `canal-montenegro`)**: bitácora interna
  de cada institución. Único miembro de aplicación: esa org. Orderer compartido.
- **Ordering service**: Raft (1 nodo en el prototipo), compartido entre los tres canales.
- **Chaincode (Go, canal público)**: `EmitAsset`, `GrantConsent`, `RevokeConsent`,
  `CheckAccess` (ABAC, deny por defecto). `CheckAccess` con resultado PERMIT emite un
  evento de chaincode.
- **Capa de aplicación (por org, fuera del ledger)**: cifrado AES-256-GCM, subida/descarga
  IPFS, escucha de eventos, envoltura de la clave AES con la clave pública X.509 del
  solicitante ante un PERMIT. El chaincode es determinista: no hace red ni criptografía
  de payload.

## Requisitos del host (macOS y Windows)

Todo el desarrollo ocurre **dentro de un Dev Container** (Linux). En el host solo hace falta:

1. **Docker Desktop** ([macOS](https://docs.docker.com/desktop/install/mac-install/) /
   [Windows](https://docs.docker.com/desktop/install/windows-install/)), corriendo.
   - Recursos recomendados: ≥ 8 GB RAM asignados (Settings → Resources).
   - Windows: backend WSL2 (opción por defecto del instalador). No hace falta configurar
     WSL2 a mano — Docker Desktop lo gestiona.
2. **VS Code** + extensión **Dev Containers** (`ms-vscode-remote.remote-containers`),
   o el CLI: `npm install -g @devcontainers/cli`.

No instalar binarios de Fabric, Go ni Node en el host: viven en el contenedor.

## Levantar el entorno

**VS Code**: abrir la carpeta del repo → `F1` → *Dev Containers: Reopen in Container*.
La primera vez tarda varios minutos: construye la imagen, instala Go/Node/Docker-in-Docker,
descarga binarios de Fabric 2.5 (LTS) y las imágenes Docker de Fabric.

**CLI** (equivalente, desde la raíz del repo):

```bash
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
```

### Verificar la instalación (dentro del contenedor)

```bash
peer version          # binario de Fabric en el PATH
configtxgen --version
docker info           # daemon Docker-in-Docker activo
docker images | grep hyperledger   # imágenes fabric-peer, fabric-orderer, fabric-ca...
```

### ¿Por qué Docker-in-Docker y no el Docker del host?

Fabric levanta peers/orderer/CAs como contenedores que hacen *bind mounts* de rutas del
filesystem (certificados MSP/TLS, génesis del canal). Si el devcontainer usara el socket
del host, esas rutas se resolverían en el filesystem del **host**, donde no existen →
mounts vacíos y errores crípticos de MSP. Con Docker-in-Docker todo el stack (devcontainer,
peers, orderer, IPFS) comparte el mismo filesystem. Costo: al reconstruir el devcontainer
se pierden imágenes/volúmenes internos (se re-descargan).

## Paso 1 — test-network de referencia (fabric-samples)

`fabric-samples` queda clonado en `~/fabric-samples` (fuera del repo — es material de
referencia, no parte del proyecto). La test-network es una red de 2 orgs + 1 orderer que
usamos para validar el entorno y como objeto de estudio antes de armar la red propia.

```bash
cd ~/fabric-samples/test-network

# Levanta: 1 orderer (Raft, single-node), 2 peers (Org1, Org2), CAs opcionales.
# Genera material criptográfico con cryptogen y crea el canal 'mychannel'.
./network.sh up createChannel

# Despliega el chaincode de ejemplo (asset-transfer-basic, Go) en 'mychannel':
# package -> install en ambos peers -> approve por cada org -> commit.
./network.sh deployCC -ccn basic -ccp ../asset-transfer-basic/chaincode-go -ccl go

# Baja todo y borra artefactos (contenedores, volúmenes, material cripto).
./network.sh down
```

Interacción manual con el chaincode de ejemplo (los `export` configuran el cliente `peer`
para actuar como admin de Org1 — identidad MSP + certificado TLS del peer):

```bash
export PATH=$HOME/fabric-samples/bin:$PATH
export FABRIC_CFG_PATH=$HOME/fabric-samples/config
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=Org1MSP
export CORE_PEER_TLS_ROOTCERT_FILE=$HOME/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=$HOME/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051

# Transacción de escritura: pasa por endorsement (ambas orgs) -> ordering -> commit
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $HOME/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem \
  -C mychannel -n basic \
  --peerAddresses localhost:7051 --tlsRootCertFiles $HOME/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
  --peerAddresses localhost:9051 --tlsRootCertFiles $HOME/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
  -c '{"function":"InitLedger","Args":[]}'

# Query: solo lectura, se evalúa contra el state DB del peer local, no genera transacción
peer chaincode query -C mychannel -n basic -c '{"Args":["GetAllAssets"]}'
```

## Paso 2 — Red propia (`network/`)

Dos clínicas de ejemplo (`ClinicaSanCristobalMSP`, `ClinicaMontenegroMSP`) + 1 orderer
Raft, sin canal de sistema (channel participation API, igual que la test-network desde
Fabric 2.3+). El material criptográfico se genera con cryptogen en `network/organizations/`
(gitignored, se regenera en cada `up`).

```bash
cd network

# cryptogen (si organizations/ no existe) + docker compose up.
./network.sh up

# Genera y une los 3 canales: canal-universal (ambas clínicas), canal-sancristobal
# y canal-montenegro (bitácora interna de cada una). Fija anchor peers.
./network.sh createChannels

# Baja los contenedores y borra organizations/ + channel-artifacts/.
./network.sh down
```

Verificar el aislamiento de los canales privados (cada peer debe ver `canal-universal`
más solo su propio canal privado):

```bash
. scripts/envVar.sh
setGlobals sancristobal && peer channel list   # canal-universal, canal-sancristobal
setGlobals montenegro   && peer channel list   # canal-universal, canal-montenegro
```

Estructura:

```
network/
├── crypto-config/    Config de cryptogen: orderer.yaml, sancristobal.yaml, montenegro.yaml
├── configtx/          configtx.yaml — 2 orgs + orderer Raft, 3 perfiles (1 por canal)
├── compose/           compose-network.yaml (orderer + peer0 de cada clínica) + peercfg/core.yaml
├── scripts/           utils.sh, envVar.sh, configUpdate.sh, createChannel.sh
├── network.sh         up / createChannels / down
└── organizations/, channel-artifacts/   generados en runtime, gitignored
```

Decisiones de diseño:

- **Sin canal de sistema**: cada canal se crea con su propio bloque de génesis
  (`configtxgen -profile <perfil> -outputBlock ...`) y se une al orderer vía
  `osnadmin channel join` (channel participation API). El mismo orderer sirve a los
  tres canales sin necesidad de un canal de sistema previo.
- **`createChannel.sh` es genérico**: recibe `<canal> <perfil> <org...>` y hace join +
  anchor peer para la lista de orgs que reciba — así `network.sh` lo reusa para los tres
  canales en vez de triplicar la lógica (como hace `fabric-samples/test-network` con
  `setAnchorPeer.sh`/`orderer.sh` fijos a `mychannel`).
- **`CORE_VM_ENDPOINT` apunta al Docker montado en los peers** (mismo patrón que
  test-network): el chaincode Go del Paso 3 se compila con el builder legacy de Fabric,
  que necesita hablarle a la API de Docker desde dentro del contenedor del peer.

## Paso 3 — Chaincode de consentimiento + ABAC (`chaincode/`)

Chaincode Go (`pfi-medical-records/chaincode`, contractapi) desplegado en
`canal-universal`. Cuatro áreas, cada una en su archivo bajo `chaincode/consent/`:

- **`asset.go`** — `EmitAsset(fhirResourceID, resourceType, ipfsCid, patientIDHash)`
  registra metadatos de un recurso ya subido a IPFS por fuera del ledger (el chaincode
  nunca toca IPFS ni el payload clínico). `GetAsset` para leer.
- **`consent.go`** — `GrantConsent(patientIDHash, grantedToOrg, resourceTypesJSON, expiry)`
  otorga consentimiento con mínimo privilegio: `resourceTypesJSON` (array JSON, p.ej.
  `["Observation"]`) no puede quedar vacío, `expiry` (RFC3339) no puede ser pasado, y una
  org no puede otorgarse consentimiento a sí misma. `RevokeConsent(patientIDHash,
  grantedToOrg, resourceTypesJSON)` revoca total (`[]`) o parcial, y solo la org que
  otorgó el consentimiento puede revocarlo. Nunca se borra el estado — el historial
  queda en el ledger (`GetConsentHistory`, vía `GetHistoryForKey`).
- **`access.go`** — `CheckAccess(resourceType, patientIDHash)` evalúa ABAC con deny por
  defecto: PERMIT solo si hay un `Consent` vigente (no revocado, no vencido) que cubra
  ese `resourceType`. Cada evaluación (PERMIT o DENY) se persiste como `AccessLog`
  (auditoría con TxID, timestamp, org, resource type, motivo) y un PERMIT además dispara
  el evento de chaincode `AccessPermitted`, que en el paso 5 escucha la app de la org
  dueña del recurso para entregar la clave AES envuelta.
- **`util.go`** — normalización determinista de listas de resource types (dedup +
  sort; la iteración de un `map` en Go no es determinista, así que nunca se persiste
  nada cuyo orden dependa de eso).

Decisión que se aparta del signature original planeado: `CheckAccess` no recibe
`requesterOrg` como parámetro, lo toma de `ctx.GetClientIdentity().GetMSPID()` —
si fuera un argumento cualquier org podría pasar el MSPID de otra y usar el
resultado como oráculo de si esa org tiene o no consentimiento sobre un paciente.

```bash
cd network
./network.sh up
./network.sh createChannels
./network.sh deployCC   # vendoriza, empaqueta, instala, aprueba y commitea en canal-universal
```

Prueba manual con el CLI `peer` (requiere endorsement de ambas orgs — política default
`MAJORITY Endorsement` con 2 orgs exige a las dos —, por eso siempre `--peerAddresses`
de ambas). Dejar ~3s entre transacciones dependientes (ver Troubleshooting):

```bash
cd network && . scripts/envVar.sh
CHANNEL=canal-universal; CC=consent

invokeBoth() {
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" -C $CHANNEL -n $CC \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$PEER0_SANCRISTOBAL_CA" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$PEER0_MONTENEGRO_CA" -c "$1"
}

setGlobals sancristobal
invokeBoth '{"function":"EmitAsset","Args":["obs-001","Observation","QmCID...","hashPaciente001"]}'
sleep 3
EXPIRY=$(date -u -d "+1 year" +"%Y-%m-%dT%H:%M:%SZ")
invokeBoth '{"function":"GrantConsent","Args":["hashPaciente001","ClinicaMontenegroMSP","[\"Observation\"]","'"$EXPIRY"'"]}'
sleep 3

setGlobals montenegro
invokeBoth '{"function":"CheckAccess","Args":["Observation","hashPaciente001"]}'   # PERMIT
```

## Troubleshooting

### `MVCC_READ_CONFLICT` al encadenar transacciones de chaincode rápido

Si se invoca una transacción que depende del resultado de otra (p.ej. `CheckAccess`
justo después de `GrantConsent` sobre el mismo paciente/org) sin esperar, ambas pueden
caer en el mismo bloque (`BatchTimeout: 2s` en `configtx.yaml`). La segunda simula
contra el estado *antes* del commit de la primera, y al validarse el bloque su read-set
queda desactualizado → se invalida con `MVCC_READ_CONFLICT`. No es un bug del
chaincode: es el comportamiento normal de Fabric ante escrituras concurrentes sobre la
misma clave. `peer chaincode invoke` no espera el commit antes de devolver el control
(muestra "successful" apenas junta las firmas de endorsement) — por eso hace falta un
`sleep` (o polling del evento de commit) entre transacciones dependientes al probar a
mano. La capa de aplicación del paso 5 va a necesitar manejar esto con reintento ante
`MVCC_READ_CONFLICT`, no asumir que un invoke exitoso ya está commiteado.

### `peer lifecycle chaincode install` falla con "broken pipe"

Síntoma:

```
Error: chaincode install failed with status: 500 - failed to invoke backing
implementation of 'InstallChaincode': could not build chaincode: docker build
failed: docker image build failed: write unix @->/var/run/docker.sock: write:
broken pipe
```

Causa: el chaincode builder legacy de Fabric 2.5 (el `peer` compila la imagen Docker
del chaincode Go llamando directo a la API de Docker) usa un cliente HTTP viejo que
es incompatible con daemons Docker/Moby recientes (confirmado roto en `29.6.1`;
funciona en `24.0.9`). El contenedor del build (`ccenv`) termina de compilar bien,
pero el daemon corta la conexión al devolver la respuesta y el cliente del peer no
lo tolera. `DOCKER_BUILDKIT=0` / `features.buildkit: false` en `daemon.json` **no**
lo resuelve — es un problema de versión del daemon, no de BuildKit.

Fix aplicado: `devcontainer.json` pinea la feature `docker-in-docker` a
`"version": "24"` (antes `"latest"`, que resolvía a la serie 29.x). Si el devcontainer
ya está construido con una versión más nueva, hace falta *Rebuild Container* para que
tome el pin. Downgrade en caliente (sin rebuild), si hace falta salir del paso ya:

```bash
apt-cache policy moby-engine   # ver versiones 24.x disponibles en el repo de MS
sudo apt-get install -y --allow-downgrades moby-engine=24.0.9-ubuntu22.04u2
sudo pkill dockerd; sudo pkill containerd
sudo sh -c 'nohup dockerd > /tmp/dockerd.log 2>&1 &'
# esperar a que responda:
until docker info >/dev/null 2>&1; do sleep 1; done
```

Nota: matar `dockerd`/`containerd` baja cualquier contenedor corriendo (la test-network
incluida) — hacerlo antes de `network.sh up`, o correr `network.sh down` después.

### `install-fabric.sh` descarga un 404 en vez del script

En la creación del devcontainer, la red puede no estar lista todavía cuando corre
`postCreateCommand`, y un proxy intermedio devuelve un cuerpo de error (`404: Not
Found`) con status HTTP 200 — `curl -f` no lo detecta como fallo. `post-create.sh`
reintenta la descarga y valida que el archivo empiece con `#!` antes de ejecutarlo.
Si falla igual, correr manualmente `bash .devcontainer/post-create.sh` de nuevo (es
idempotente salvo por el append a `.bashrc`, que ya está guardado con un check).

## Estructura del proyecto (se completa por etapas)

```
.devcontainer/   Entorno de desarrollo reproducible (paso 0)
network/         Red Fabric propia: configtx.yaml, docker-compose, scripts (paso 2)
chaincode/       Chaincode Go: consentimiento + ABAC + auditoría (paso 3)
application/     Cliente por org: cifrado, IPFS, eventos, entrega de clave (paso 5)
```

## Glosario mínimo para la defensa

- **MSP (Membership Service Provider)**: define qué certificados X.509 identifican a los
  miembros de una org. Cada org tiene su MSP; peers y orderers validan firmas contra él.
- **Canal**: ledger independiente con su propia política de membresía. Las orgs fuera del
  canal no ven sus datos.
- **Endorsement**: los peers designados por la política ejecutan la transacción y firman
  el read/write set. Sin firmas suficientes, la transacción se invalida en commit.
- **Ordering (Raft)**: ordena transacciones en bloques. Raft = líder + seguidores con log
  replicado; tolera fallas de minoría (crash fault tolerant, no bizantino).
- **Ciclo de vida de una tx**: propuesta del cliente → simulación/endorsement en peers →
  envío al orderer → bloque → validación (política + MVCC) → commit en cada peer.
