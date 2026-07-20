import { useEffect, useState } from 'react';
import { api, ORGS, useSSE } from './api.js';
import TopologyPanel from './components/TopologyPanel.jsx';
import ActionsPanel from './components/ActionsPanel.jsx';
import AssetsPanel from './components/AssetsPanel.jsx';
import ConsentsPanel from './components/ConsentsPanel.jsx';
import AccessLogPanel from './components/AccessLogPanel.jsx';
import EventFeed from './components/EventFeed.jsx';

export default function App() {
  // Org activa: con qué identidad se ejecutan las acciones ("actuar como").
  const [org, setOrg] = useState('sancristobal');
  // tick: contador de refresco — las tablas refetchean cuando cambia
  // (tras cada acción propia y ante cada evento SSE).
  const [tick, setTick] = useState(0);
  const [feed, setFeed] = useState([]);
  const bump = () => setTick((t) => t + 1);

  // Entregas previas al load (el feed SSE solo trae lo nuevo).
  useEffect(() => {
    api('/deliveries')
      .then((ds) => setFeed(
        ds.map((d) => ({ type: 'key-delivery', delivery: d, receivedAt: Date.parse(d.timestamp) })).reverse(),
      ))
      .catch(() => {});
  }, []);

  useSSE((msg) => {
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
          {Object.entries(ORGS).map(([key, o]) => (
            <button
              key={key}
              className={`org-btn ${org === key ? 'active' : ''}`}
              style={org === key ? { borderColor: o.color, color: o.color } : undefined}
              onClick={() => setOrg(key)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </header>

      <div className="layout">
        <div className="main-col">
          <TopologyPanel org={org} tick={tick} />
          <ActionsPanel org={org} onDone={bump} />
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
