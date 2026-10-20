// Formas de lo que devuelve el BFF (application/server). Los nombres de campo
// son los del ledger (PascalCase) o los del registro de clínicas (camelCase).

export interface Clinic {
  key: string
  nombre: string
  mspId: string
  estado: string
  jurisdiccion?: string
  privateChannel?: string
  peerEndpoint?: string
  peerOk?: boolean
  onChain?: { estado?: string; motivoBaja?: string }
}

// Clinic + lo que le agrega la UI (color estable, bandera de activa, rótulo).
export interface ClinicView extends Clinic {
  color: string
  activa: boolean
  label: string
}

export interface Asset {
  FhirResourceID: string
  ResourceType: string
  IpfsCid: string
  PatientIDHash: string
  OwnerOrg: string
  Timestamp: string
  OriginChannel?: string
  _channel?: string
}

export interface Consent {
  PatientIDHash: string
  GrantedByOrg: string
  GrantedToOrg: string
  ResourceTypes: string[]
  Expiry: string
  Revoked: boolean
}

export interface ConsentHistoryEntry {
  TxID: string
  Timestamp: string
  Consent?: Consent
}

export interface AccessLog {
  TxID: string
  Timestamp: string
  RequesterOrg: string
  FhirResourceID?: string
  ResourceType: string
  PatientIDHash: string
  Decision: 'PERMIT' | 'DENY'
  Reason?: string
  _channel?: string
}

export interface Delivery {
  id: string
  fromOrg: string
  toOrg: string
  recipientOrgKey: string
  resourceType: string
  fhirResourceID: string
  envelope: unknown
  timestamp: string
}

export interface BlockInfo {
  numero: number
  canal: string
  transacciones: number
  dataHash?: string
  previousHash?: string
}

// Mensaje SSE de /api/events. Según `type` vienen unos campos u otros; los
// eventos de acceso (AccessPermitted) no traen `type`.
export interface SseMessage {
  type?: 'clinic-op' | 'clinic-event' | 'key-delivery'
  estado?: string
  linea?: string
  delivery?: Delivery
  eventName?: string
  mspId?: string
  nombre?: string
  requesterOrg?: string
  fhirResourceID?: string
  resourceType?: string
  patientIDHash?: string
  blockNumber?: number
  txId?: string
}

export interface FeedItem extends SseMessage {
  receivedAt: number
}
