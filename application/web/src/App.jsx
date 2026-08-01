import { useEffect, useState } from 'react';
import { api, useClinics, useSSE } from './api.js';
import TopologyPanel from './components/TopologyPanel.jsx';
import ActionsPanel from './components/ActionsPanel.jsx';
import ClinicsPanel from './components/ClinicsPanel.jsx';
import AssetsPanel from './components/AssetsPanel.jsx';
import ConsentsPanel from './components/ConsentsPanel.jsx';
import AccessLogPanel from './components/AccessLogPanel.jsx';
import EventFeed from './components/EventFeed.jsx';

export default function App() {
  const { clinics, reload: reloadClinics } = useClinics();
  const activas = clinics.filter((c) => c.activa);

  // Org activa: con qué identidad se ejecutan las acciones ("actuar como").
  // Arranca vacía y la fija la primera clínica que llega: cuáles existen se
  // sabe recién cuando responde /api/clinics.
  const [org, setOrg] = useState(null);
  // tick: contador de refresco — las tablas refetchean cuando cambia
  // (tras cada acción propia y ante cada evento SSE).
  const [tick, setTick] = useState(0);
  const [feed, setFeed] = useState([]);
  const bump = () => setTick((t) => t + 1);

  // Si la org activa desaparece (baja) o todavía no había ninguna, se cae a la
  // primera activa. Sin esto, dar de baja la clínica seleccionada dejaría la UI
  // firmando como una org que ya no existe.
  useEffect(() => {
    if (activas.length === 0) return;
    if (!org || !activas.some((c) => c.key === org)) {
      setOrg(activas[0].key);
    }
  }, [activas, org]);

  // Entregas previas al load (el feed SSE solo trae lo nuevo).
  useEffect(() => {
    api('/deliveries')
      .then((ds) => setFeed(
        ds.map((d) => ({ type: 'key-delivery', delivery: d, receivedAt: Date.parse(d.timestamp) })).reverse(),
      ))
      .catch(() => {});
  }, []);

  useSSE((msg) => {
    // El progreso de un alta/baja no va al feed general: lo muestra el panel de
    // clínicas, que es donde el usuario está mirando mientras corre.
    if (msg.type === 'clinic-op') {
      if (msg.estado === 'ok') reloadClinics();
      return;
    }
    if (msg.type === 'clinic-event') reloadClinics();
    setFeed((f) => [{ ...msg, receivedAt: Date.now() }, ...f].slice(0, 100));
    bump();
  });

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>PFI — Bus de interoperabilidad</h1>
          <p className="subtitle">Hyperledger Fabric + IPFS · consentimiento y ABAC entre clínicas</p>
        </div>
        <div className="org-switcher" role="group" aria-label="Actuar como">
          <span className="org-switcher-label">Actuar como</span>
          {activas.map((c) => (
            <button
              key={c.key}
              className={`org-btn ${org === c.key ? 'active' : ''}`}
              style={org === c.key ? { borderColor: c.color, color: c.color } : undefined}
              onClick={() => setOrg(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      <div className="layout">
        <div className="main-col">
          <TopologyPanel org={org} clinics={activas} tick={tick} />
          <ClinicsPanel clinics={clinics} onChanged={() => { reloadClinics(); bump(); }} />
          {org && <ActionsPanel org={org} clinics={activas} tick={tick} onDone={bump} />}
          <AssetsPanel tick={tick} />
          <ConsentsPanel tick={tick} />
          <AccessLogPanel tick={tick} />
        </div>
        <aside className="side-col">
          <EventFeed feed={feed} />
        </aside>
      </div>
    </div>
  );
}
