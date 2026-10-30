import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminContext } from './context.js';
import { ArrowRight, BookUser, ChefHat, ClipboardList, LockKeyhole, LogOut, Menu, Package, Settings, ShoppingCart, Users, Wallet, X } from 'lucide-react';
import { BrandLogos, Spinner } from '../components/ui.jsx';
import { request, subscribe } from '../lib/api.js';
import { go, paths } from '../lib/router.js';
import { readSession, writeSession } from '../lib/storage.js';
import OrdersPage from './OrdersPage.jsx';
import KitchenPage from './KitchenPage.jsx';
import FinancePage from './FinancePage.jsx';
import ProductsPage from './ProductsPage.jsx';
import SettingsPage from './SettingsPage.jsx';
import UsersPage from './UsersPage.jsx';
import PosPage from './PosPage.jsx';
import CreditsPage from './CreditsPage.jsx';

const TABS = [
  { id: 'balcao', group: 'Operação', label: 'Venda no balcão', icon: ShoppingCart, permission: 'pos.sell', Page: PosPage },
  { id: 'pedidos', group: 'Operação', label: 'Pedidos', icon: ClipboardList, permission: 'orders.view', Page: OrdersPage },
  { id: 'cozinha', group: 'Operação', label: 'Cozinha / Produção', icon: ChefHat, permission: 'kitchen.view', Page: KitchenPage },
  { id: 'fiados', group: 'Operação', label: 'Fiados', icon: BookUser, permission: 'credits.view', Page: CreditsPage },
  { id: 'financeiro', group: 'Gestão', label: 'Financeiro', icon: Wallet, permission: 'finance.view', Page: FinancePage },
  { id: 'produtos', group: 'Gestão', label: 'Produtos', icon: Package, permission: 'catalog.manage', Page: ProductsPage },
  { id: 'configuracoes', group: 'Administração', label: 'Configurações', icon: Settings, permission: 'settings.manage', Page: SettingsPage },
  { id: 'usuarios', group: 'Administração', label: 'Usuários', icon: Users, permission: 'users.manage', Page: UsersPage }
];

function Login({ onLogin }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try { onLogin(await request('/auth/login', { method: 'POST', body: form })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <form className="login-card" onSubmit={submit}>
      <BrandLogos size="md" />
      <h1><LockKeyhole size={20} /> Área da equipe</h1>
      <p className="muted">Acesso restrito à equipe autorizada.</p>
      <label className="field"><span>E-mail</span><input type="email" required autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
      <label className="field"><span>Senha</span><input type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
      {error && <p className="alert alert-error">{error}</p>}
      <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Entrando...' : 'Entrar'} <ArrowRight size={16} /></button>
      <a className="back-link center" href={paths.home}>Voltar ao site</a>
    </form>
  </main>;
}

export default function AdminApp({ tab }) {
  const [token, setToken] = useState(() => readSession('eag-admin-token'));
  const [user, setUser] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [live, setLive] = useState(false);
  const listeners = useRef(new Set());

  const logout = useCallback(() => { writeSession('eag-admin-token', ''); setToken(''); setUser(null); }, []);

  // Chamada autenticada: sessão expirada leva de volta ao login.
  const call = useCallback(async (path, options = {}) => {
    try { return await request(path, { ...options, token }); }
    catch (error) { if (error.status === 401) logout(); throw error; }
  }, [token, logout]);

  useEffect(() => {
    if (!token) return;
    request('/me', { token }).then(setUser).catch((error) => { if (error.status === 401) logout(); });
  }, [token, logout]);

  useEffect(() => {
    if (!token || !user) return undefined;
    return subscribe('/admin/events', { token, onStatus: setLive, onChange: (event) => listeners.current.forEach((fn) => fn(event)) });
  }, [token, user]);

  // Sem tempo real (ou conexão caída): atualização periódica das telas abertas.
  useEffect(() => {
    if (!user || live) return undefined;
    const timer = setInterval(() => listeners.current.forEach((fn) => fn({ type: 'tick' })), 8000);
    return () => clearInterval(timer);
  }, [user, live]);

  const onEvent = useCallback((fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); }, []);
  const can = useCallback((permission) => Boolean(user?.permissions?.includes(permission)), [user]);
  const context = useMemo(() => ({ token, user, call, can, onEvent, live }), [token, user, call, can, onEvent, live]);
  const allowed = TABS.filter((item) => can(item.permission));
  const active = allowed.find((item) => item.id === tab) || allowed[0];
  // Endereço sem aba (ou aba sem permissão) vai para a primeira área permitida.
  useEffect(() => { if (active && active.id !== tab) go(paths.admin(active.id)); }, [active, tab]);
  // Menu do celular: fecha ao trocar de tela e com Esc; trava a rolagem da página enquanto aberto.
  useEffect(() => { setMenuOpen(false); }, [tab]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll'); };
  }, [menuOpen]);

  if (!token) return <Login onLogin={(data) => { writeSession('eag-admin-token', data.token); setUser(data.user); setToken(data.token); }} />;
  if (!user) return <main className="page"><Spinner label="Abrindo o painel..." /></main>;

  const groups = [...new Set(allowed.map((item) => item.group))];
  const initials = user.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  return <AdminContext.Provider value={context}>
    <div className={`admin-shell ${menuOpen ? 'menu-open' : ''}`}>
      <header className="admin-topbar">
        <button type="button" className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu" aria-expanded={menuOpen}><Menu size={20} /></button>
        <div className="admin-topbar-title">{active && <active.icon size={18} />}<b>{active?.label || 'Painel'}</b></div>
        <span className="avatar" title={`${user.name} · ${user.roleLabel}`}>{initials}</span>
      </header>
      <div className="admin-overlay" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside className="admin-side" aria-label="Menu do painel">
        <div className="admin-side-head">
          <a href={paths.home} className="admin-brand"><img src="/brand/la-em-gracas-lanches.png" alt="" /><span><b>Lá em Graças</b><small>Painel da equipe</small></span></a>
          <button type="button" className="icon-btn admin-close" onClick={() => setMenuOpen(false)} aria-label="Fechar menu"><X size={18} /></button>
        </div>
        <nav>
          {groups.map((group) => <div key={group} className="nav-group">
            <span className="nav-group-label">{group}</span>
            {allowed.filter((item) => item.group === group).map((item) => <a key={item.id} href={paths.admin(item.id)} className={active?.id === item.id ? 'active' : ''}
              aria-current={active?.id === item.id ? 'page' : undefined}><item.icon size={18} /><span>{item.label}</span></a>)}
          </div>)}
        </nav>
        <div className="admin-user">
          <span className="avatar">{initials}</span>
          <div><b>{user.name}</b><small>{user.roleLabel}</small><span className="sync-state">{live ? 'Tempo real' : 'Sincronizado'}</span></div>
          <button type="button" className="icon-btn" onClick={logout} title="Sair" aria-label="Sair"><LogOut size={16} /></button>
        </div>
      </aside>
      <main className="admin-main">
        {active ? <active.Page key={active.id} /> : <p className="alert alert-warning">Seu perfil não tem acesso a nenhuma área.</p>}
      </main>
    </div>
  </AdminContext.Provider>;
}
