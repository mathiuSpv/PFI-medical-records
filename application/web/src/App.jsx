import { useEffect, useState } from 'react';
import { RUTA_MAPA, api, idDeRuta, useClinics, useRuta, useSSE } from './api.js';
import ActionsPanel from './components/ActionsPanel.jsx';
import ClinicsPanel from './components/ClinicsPanel.jsx';
import AssetsPanel from './components/AssetsPanel.jsx';
import ConsentsPanel from './components/ConsentsPanel.jsx';
import AccessLogPanel from './components/AccessLogPanel.jsx';
import EventFeed from './components/EventFeed.jsx';
import GraphPanel from './components/GraphPanel.jsx';
import AssetPage from './components/AssetPage.jsx';

export default function App() {
  const { clinics, reload: reloadClinics } = useClinics();
  const activas = clinics.filter((c) => c.activa);

  // No hay identidad global: la consola administra la red entera y no actúa como
  // ninguna institución. La org que firma se elige dentro de cada acción que
  // genera una transacción (ver ActionsPanel y AssetPage).
  //
  // tick: contador de refresco — las tablas refetchean cuando cambia
  // (tras cada acción propia y ante cada evento SSE).
  const [tick, setTick] = useState(0);
  const [feed, setFeed] = useState([]);
  const [solapa, setSolapa] = useState('operacion');
  const bump = () => setTick((t) => t + 1);

  // Ruta por hash: '#/activo/<id>' abre la página del documento, '#/mapa' la
  // vista dedicada del grafo, cualquier otra cosa es el dashboard.
  const ruta = useRuta();
  const activoId = idDeRuta(ruta);
  const soloMapa = ruta === RUTA_MAPA;

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

  // Vista del mapa: se devuelve antes del encabezado a propósito, porque la
  // idea es que no haya nada más en pantalla que la topología.
  if (soloMapa) return <GraphPanel clinics={clinics} tick={tick} soloMapa />;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>PFI — Consola de red</h1>
          <p className="subtitle">
            Hyperledger Fabric + IPFS · administración del bus: todas las instituciones, activos y consentimientos
          </p>
        </div>
        <div className="header-tools">
          <span className="hint">
            {activas.length} institución{activas.length === 1 ? '' : 'es'} activa{activas.length === 1 ? '' : 's'} en el bus
          </span>
        </div>
      </header>

      {activoId ? <AssetPage id={activoId} tick={tick} activas={activas} onDone={bump} /> : (
      <>
      {/* Dos vistas de lo mismo: operar el bus, o mirar lo que quedó registrado
          como grafo. La segunda va a ancho completo y sin el feed, porque el
          lienzo necesita todo el espacio disponible. */}
      <nav className="solapas" role="tablist" aria-label="Vistas">
        {[['operacion', 'Operación'], ['red', 'Red de datos']].map(([id, etiqueta]) => (
          <button
            key={id}
            role="tab"
            aria-selected={solapa === id}
            className={`solapa ${solapa === id ? 'active' : ''}`}
            onClick={() => setSolapa(id)}
          >
            {etiqueta}
          </button>
        ))}
      </nav>

      {solapa === 'operacion' ? (
        <div className="layout">
          <div className="main-col">
            <ClinicsPanel clinics={clinics} onChanged={() => { reloadClinics(); bump(); }} />
            {activas.length > 0 && <ActionsPanel clinics={activas} onDone={bump} />}
            <AssetsPanel tick={tick} />
            <ConsentsPanel tick={tick} />
            <AccessLogPanel tick={tick} />
          </div>
          <aside className="side-col">
            <EventFeed feed={feed} />
          </aside>
        </div>
      ) : (
        <div className="main-col">
          <GraphPanel clinics={clinics} tick={tick} />
        </div>
      )}
      </>
      )}
    </div>
  );
}
