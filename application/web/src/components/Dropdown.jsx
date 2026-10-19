// Dropdown propio: reemplaza el <select> nativo para poder estilar cada fila del
// listado (el popup nativo lo dibuja el SO y no se puede estilar de verdad).
// options = [{ value, label }]. onChange(value). Cierra al elegir o al clickear
// afuera; teclado básico (Enter/Espacio abre, Escape cierra).
import { useEffect, useRef, useState } from 'react';

export default function Dropdown({ value, onChange, options, disabled = false, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const alClickear = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const alTecla = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', alClickear);
    document.addEventListener('keydown', alTecla);
    return () => {
      document.removeEventListener('click', alClickear);
      document.removeEventListener('keydown', alTecla);
    };
  }, [open]);

  const sel = options.find((o) => o.value === value);

  return (
    <div className="dd" ref={ref}>
      <button
        type="button"
        className="dd-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen((o) => !o); }}
      >
        <span className="dd-value">{sel ? sel.label : ''}</span>
        <span className="dd-caret" aria-hidden="true" />
      </button>
      {open && (
        <ul className="dd-list" role="listbox">
          {options.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`dd-opt ${o.value === value ? 'active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
