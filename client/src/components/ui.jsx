// Componentes visuais compartilhados.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

// ---------- Marca (arquivos oficiais em /public/brand) ----------

export function BrandLogos({ size = 'md', only }) {
  return <span className={`brand-logos brand-${size}`}>
    {only !== 'snack' && <img src="/brand/eag-gracas.png" alt="EAG — Encontro de Adolescentes Graças" className="logo-eag" />}
    {only !== 'eag' && <img src="/brand/la-em-gracas-lanches.png" alt="Lá em Graças Lanches" className="logo-snack" />}
  </span>;
}

// ---------- Avisos (toast) ----------

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((message, tone = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return <ToastContext.Provider value={show}>
    {children}
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>
        {toast.tone === 'error' ? <AlertTriangle size={18} /> : toast.tone === 'info' ? <Info size={18} /> : <CheckCircle2 size={18} />}
        <span>{toast.message}</span>
        <button type="button" aria-label="Fechar aviso" onClick={() => setToasts((list) => list.filter((t) => t.id !== toast.id))}><X size={15} /></button>
      </div>)}
    </div>
  </ToastContext.Provider>;
}

// ---------- Modal ----------

let openModals = 0;

export function Modal({ title, subtitle, onClose, children, footer, size = 'md', className = '' }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Só o modal mais recente responde ao Esc.
    const depth = ++openModals;
    const onKey = (event) => { if (event.key === 'Escape' && depth === openModals) closeRef.current?.(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      openModals -= 1;
      if (!openModals) document.body.classList.remove('no-scroll');
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
    <section className={`modal modal-${size} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      {title && <header className="modal-head">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        {onClose && <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar"><X size={18} /></button>}
      </header>}
      {!title && onClose && <button type="button" className="modal-close-float" onClick={onClose} aria-label="Fechar"><X size={18} /></button>}
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </section>
  </div>;
}

// ---------- Confirmação (com campo de motivo opcional) ----------

const ConfirmContext = createContext(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const [text, setText] = useState('');
  const resolver = useRef(null);
  const confirm = useCallback((options) => new Promise((resolve) => {
    resolver.current = resolve;
    setText('');
    setState(options);
  }), []);
  const close = (value) => { resolver.current?.(value); resolver.current = null; setState(null); };
  const needsText = Boolean(state?.input);
  const minLength = state?.input?.minLength ?? 3;
  return <ConfirmContext.Provider value={confirm}>
    {children}
    {state && <Modal title={state.title} onClose={() => close(false)} size="sm"
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={() => close(false)}>{state.cancelLabel || 'Voltar'}</button>
        {state.choices ? state.choices.map((choice) => <button type="button" key={choice.value} className={`btn ${choice.className || 'btn-outline'}`} onClick={() => close(choice.value)}>{choice.label}</button>)
          : <button type="button" className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`} disabled={needsText && text.trim().length < minLength}
            onClick={() => close(needsText ? text.trim() : true)}>{state.confirmLabel || 'Confirmar'}</button>}
      </>}>
      {state.message && <div className="confirm-message">{state.message}</div>}
      {needsText && <label className="field">
        <span>{state.input.label}</span>
        {state.input.type === 'password'
          ? <input type="password" autoFocus autoComplete="new-password" value={text} maxLength={200} onChange={(event) => setText(event.target.value)} />
          : <textarea rows={3} autoFocus value={text} maxLength={300} onChange={(event) => setText(event.target.value)} placeholder={state.input.placeholder || ''} />}
        <small className="hint">Mínimo de {minLength} caracteres.</small>
      </label>}
    </Modal>}
  </ConfirmContext.Provider>;
}

// ---------- Elementos simples ----------

export function Badge({ tone = 'neutral', children, icon }) {
  return <span className={`badge badge-${tone}`}>{icon}{children}</span>;
}

export function Spinner({ label = 'Carregando...' }) {
  return <div className="spinner-wrap"><Loader2 className="spin" size={22} /><span>{label}</span></div>;
}

export function EmptyState({ icon, title, children, action }) {
  return <div className="empty-state">
    {icon && <div className="empty-icon">{icon}</div>}
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action}
  </div>;
}

export function ErrorState({ message, onRetry }) {
  return <EmptyState icon={<AlertTriangle size={26} />} title="Não foi possível carregar"
    action={onRetry && <button type="button" className="btn btn-outline" onClick={onRetry}>Tentar novamente</button>}>{message}</EmptyState>;
}

export function Field({ label, hint, error, children, className = '' }) {
  return <label className={`field ${error ? 'has-error' : ''} ${className}`}>
    <span>{label}</span>
    {children}
    {error ? <small className="field-error">{error}</small> : hint ? <small className="hint">{hint}</small> : null}
  </label>;
}

export function Toggle({ checked, onChange, label, description, disabled }) {
  return <label className={`toggle ${disabled ? 'is-disabled' : ''}`}>
    <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
    <span className="toggle-text"><b>{label}</b>{description && <small>{description}</small>}</span>
  </label>;
}

// Campo de valor em reais (aceita vírgula).
export function MoneyInput({ value, onChange, ...props }) {
  return <div className="money-input"><span>R$</span>
    <input inputMode="decimal" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value.replace(/[^\d.,]/g, ''))} placeholder="0,00" {...props} />
  </div>;
}

// Relógio compartilhado para contadores de tempo decorrido.
export function useNow(interval = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}
