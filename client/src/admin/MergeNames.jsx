// Juntar nomes da mesma pessoa escritos de jeitos diferentes ("Julio", "Júlio César", "Julio Cezar").
// Mostra grupos de nomes parecidos (sugeridos ou escolhidos na lista); ao juntar, as comandas passam a ter um nome só.
import React, { useState } from 'react';
import { Modal, useToast } from '../components/ui.jsx';
import { money } from '../lib/api.js';
import { useAdmin } from './context.js';
import { sameName } from './nomes.js';

// Grupos de clientes da mesma equipe com nomes que cabem um no outro (só os grupos com 2 ou mais nomes).
export function suggestMerges(customers) {
  const parent = customers.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  customers.forEach((a, i) => customers.forEach((b, j) => {
    if (j > i && a.team === b.team && sameName(a.name, b.name)) parent[root(j)] = root(i);
  }));
  const groups = new Map();
  customers.forEach((c, i) => groups.set(root(i), [...(groups.get(root(i)) || []), c]));
  return [...groups.values()].filter((group) => group.length > 1);
}

// O nome mais completo do grupo, como sugestão de nome final.
const longest = (group) => group.map((c) => c.name.trim()).sort((a, b) => b.length - a.length)[0];

function Group({ group, onMerged }) {
  const { call } = useAdmin();
  const toast = useToast();
  const [checked, setChecked] = useState(() => Object.fromEntries(group.map((c) => [c.key, true])));
  const [name, setName] = useState(() => longest(group));
  const [busy, setBusy] = useState(false);
  const chosen = group.filter((c) => checked[c.key]);

  const merge = async () => {
    setBusy(true);
    try {
      const orderIds = chosen.flatMap((c) => c.orders.map((o) => o.id));
      await call('/finance/credits/rename', { method: 'POST', body: { orderIds, buyerName: name.trim() } });
      toast(`${chosen.length} nomes juntados em "${name.trim()}".`);
      onMerged();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return <li className="merge-group">
    <small className="muted">Equipe {group[0].team}</small>
    {group.map((c) => <label key={c.key} className="check-line">
      <input type="checkbox" checked={Boolean(checked[c.key])} onChange={(e) => setChecked((current) => ({ ...current, [c.key]: e.target.checked }))} />
      <span><b>{c.name}</b> · {c.orders.length} {c.orders.length === 1 ? 'comanda' : 'comandas'} · {money(c.total)}</span>
    </label>)}
    <div className="merge-row">
      <label className="field"><span>Nome final</span><input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
      <button type="button" className="btn btn-primary" disabled={busy || chosen.length < 2 || name.trim().length < 2} onClick={merge}>
        {busy ? 'Juntando...' : `Juntar ${chosen.length}`}</button>
    </div>
  </li>;
}

export default function MergeNames({ groups, title, onClose, onDone }) {
  const [done, setDone] = useState({});
  const left = groups.filter((_, i) => !done[i]);
  return <Modal title={title} subtitle="Desmarque o que não for da mesma pessoa e confira o nome final" onClose={onClose} size="lg"
    footer={<button type="button" className="btn btn-ghost" onClick={onClose}>Fechar</button>}>
    {!left.length ? <p className="alert alert-info">Nenhum nome parecido para juntar.</p>
      : <ul className="merge-list">{groups.map((group, i) => !done[i] && <Group key={group.map((c) => c.key).join('|')} group={group}
        onMerged={() => { setDone((current) => ({ ...current, [i]: true })); onDone(); }} />)}</ul>}
  </Modal>;
}
