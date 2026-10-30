import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, UserCheck, UserX } from 'lucide-react';
import { Badge, ErrorState, Field, Modal, Spinner, useConfirm, useToast } from '../components/ui.jsx';
import { fullDateTime } from '../lib/api.js';
import { ROLES } from '../lib/labels.js';
import { useAdmin } from './context.js';

function UserForm({ onClose, onSaved }) {
  const { call } = useAdmin();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'kitchen' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try { await call('/admin/users', { method: 'POST', body: form }); onSaved(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal title="Novo usuário" onClose={onClose} size="sm"
    footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button><button type="submit" form="user-form" className="btn btn-primary" disabled={busy}>Criar usuário</button></>}>
    <form id="user-form" onSubmit={submit} className="stack">
      <Field label="Nome"><input required minLength={2} maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="E-mail"><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Senha inicial" hint="Mínimo de 8 caracteres"><input required type="password" minLength={8} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
      <Field label="Perfil" hint={ROLES[form.role].description}>
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
      </Field>
      {error && <p className="alert alert-error">{error}</p>}
    </form>
  </Modal>;
}

export default function UsersPage() {
  const { call, user } = useAdmin();
  const toast = useToast();
  const confirm = useConfirm();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try { setUsers(await call('/admin/users')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);

  const patch = async (target, body, message) => {
    try { await call(`/admin/users/${target.id}`, { method: 'PATCH', body }); toast(message); load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const resetPassword = async (target) => {
    const password = await confirm({ title: `Nova senha para ${target.name}`, input: { label: 'Nova senha (mínimo 8 caracteres)', minLength: 8, type: 'password' }, confirmLabel: 'Alterar senha' });
    if (password) patch(target, { password }, 'Senha alterada.');
  };

  return <div className="admin-page">
    <header className="admin-page-head">
      <div><h1>Usuários</h1><p>Quem acessa o painel e o que cada um pode fazer.</p></div>
      <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> Novo usuário</button>
    </header>
    <div className="roles-legend">{Object.entries(ROLES).map(([k, v]) => <div key={k}><b>{v.label}</b><span>{v.description}</span></div>)}</div>
    {error ? <ErrorState message={error} onRetry={load} /> : !users ? <Spinner /> : <div className="table-wrap"><table className="table">
      <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th>Criado em</th><th /></tr></thead>
      <tbody>{users.map((u) => <tr key={u.id} className={u.active ? '' : 'row-voided'}>
        <td><b>{u.name}</b>{u.id === user.id && <small>Você</small>}</td>
        <td>{u.email}</td>
        <td><select value={u.role} disabled={u.id === user.id} onChange={(e) => patch(u, { role: e.target.value }, 'Perfil alterado.')} aria-label="Perfil">
          {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></td>
        <td>{u.active ? <Badge tone="success">Ativo</Badge> : <Badge tone="neutral">Desativado</Badge>}</td>
        <td>{fullDateTime(u.created_at)}</td>
        <td className="actions">
          <button type="button" className="icon-btn" title="Alterar senha" onClick={() => resetPassword(u)}><KeyRound size={16} /></button>
          {u.id !== user.id && <button type="button" className="icon-btn" title={u.active ? 'Desativar' : 'Reativar'} onClick={() => patch(u, { active: !u.active }, u.active ? 'Usuário desativado.' : 'Usuário reativado.')}>{u.active ? <UserX size={16} /> : <UserCheck size={16} />}</button>}
        </td>
      </tr>)}</tbody></table></div>}
    {creating && <UserForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); toast('Usuário criado.'); load(); }} />}
  </div>;
}
