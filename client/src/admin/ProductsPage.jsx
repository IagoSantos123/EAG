import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, ArchiveRestore, ImagePlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Field, Modal, MoneyInput, Spinner, Toggle, useConfirm, useToast } from '../components/ui.jsx';
import { imageUrl, money, parseMoney } from '../lib/api.js';
import { MODES } from '../lib/labels.js';
import { useAdmin } from './context.js';
import { ProductThumb } from '../shop/productUtils.jsx';

const blankProduct = (mode = 'snack') => ({
  id: null, name: '', description: '', mode, categoryId: null, price: '', available: true, imageUrl: '', trackStock: false, stock: '',
  prepMinutes: '', allowNotes: true, customTextLabel: '', customTextRequired: false, adminNotes: '', needsReview: false, sortOrder: 0, optionGroups: [], kitchen: true
});

const toForm = (p) => ({
  ...p, price: p.price.toFixed(2).replace('.', ','), trackStock: p.stock != null, stock: p.stock == null ? '' : String(p.stock),
  prepMinutes: p.prepMinutes == null ? '' : String(p.prepMinutes),
  optionGroups: p.optionGroups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o, extra: o.extra ? o.extra.toFixed(2).replace('.', ',') : '' })) }))
});

// Redimensiona no navegador para enviar imagens leves.
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error('Use uma imagem JPG, PNG ou WEBP.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Imagem inválida.'));
      img.onload = () => {
        const scale = Math.min(1, 900 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function OptionGroupsEditor({ groups, onChange }) {
  const update = (index, patch) => onChange(groups.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  const updateOption = (gi, oi, patch) => update(gi, { options: groups[gi].options.map((o, i) => (i === oi ? { ...o, ...patch } : o)) });
  return <div className="groups-editor">
    {groups.length === 0 && <p className="muted small">Sem variações. Use grupos para tamanhos, sabores, adicionais etc.</p>}
    {groups.map((group, gi) => <div key={gi} className="group-card">
      <div className="group-head">
        <Field label="Nome do grupo"><input value={group.name} maxLength={60} onChange={(e) => update(gi, { name: e.target.value })} placeholder="Ex.: Sabores, Tamanho, Adicionais" /></Field>
        <Field label="Mínimo" hint="0 = opcional"><input type="number" min="0" max="20" value={group.min} onChange={(e) => update(gi, { min: Math.max(0, Number(e.target.value) || 0) })} /></Field>
        <Field label="Máximo"><input type="number" min="1" max="20" value={group.max} onChange={(e) => update(gi, { max: Math.max(1, Number(e.target.value) || 1) })} /></Field>
        <button type="button" className="icon-btn danger" onClick={() => onChange(groups.filter((_, i) => i !== gi))} aria-label="Remover grupo"><Trash2 size={16} /></button>
      </div>
      <table className="table compact options-table"><thead><tr><th>Opção</th><th>Adicional (R$)</th><th>Disponível</th><th /></tr></thead>
        <tbody>{group.options.map((option, oi) => <tr key={oi}>
          <td><input value={option.name} maxLength={80} onChange={(e) => updateOption(gi, oi, { name: e.target.value })} placeholder="Nome da opção" /></td>
          <td><MoneyInput value={option.extra} onChange={(v) => updateOption(gi, oi, { extra: v })} placeholder="grátis" /></td>
          <td><input type="checkbox" checked={option.available !== false} onChange={(e) => updateOption(gi, oi, { available: e.target.checked })} aria-label="Disponível" /></td>
          <td><button type="button" className="icon-btn" onClick={() => update(gi, { options: group.options.filter((_, i) => i !== oi) })} aria-label="Remover opção"><X size={15} /></button></td>
        </tr>)}</tbody></table>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => update(gi, { options: [...group.options, { name: '', extra: '', available: true }] })}><Plus size={14} /> Opção</button>
    </div>)}
    <button type="button" className="btn btn-outline btn-sm" onClick={() => onChange([...groups, { name: '', min: 0, max: 1, options: [{ name: '', extra: '', available: true }] }])}><Plus size={15} /> Adicionar grupo de opções</button>
  </div>;
}

function ProductEditor({ initial, categories, onClose, onSaved }) {
  const { call } = useAdmin();
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const modeCategories = categories.filter((c) => c.mode === form.mode);

  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    try { const dataUrl = await resizeImage(file); const result = await call('/admin/images', { method: 'POST', body: { dataUrl } }); set('imageUrl', result.url); }
    catch (err) { toast(err.message, 'error'); } finally { setUploading(false); }
  };

  const save = async (event) => {
    event.preventDefault();
    setError('');
    const price = parseMoney(form.price);
    if (Number.isNaN(price) || price < 0) { setError('Informe um preço válido.'); return; }
    let groups;
    try {
      groups = form.optionGroups.map((g) => {
        if (!g.name.trim()) throw new Error('Dê um nome a cada grupo de opções.');
        if (!g.options.length) throw new Error(`O grupo "${g.name}" precisa de ao menos uma opção.`);
        return { name: g.name.trim(), min: Number(g.min), max: Number(g.max), options: g.options.map((o) => {
          if (!o.name.trim()) throw new Error(`Há uma opção sem nome no grupo "${g.name}".`);
          const extra = o.extra === '' ? 0 : parseMoney(o.extra);
          if (Number.isNaN(extra) || extra < 0) throw new Error(`Valor adicional inválido em "${o.name}".`);
          return { name: o.name.trim(), extra, available: o.available !== false };
        }) };
      });
    } catch (err) { setError(err.message); return; }
    const stock = form.trackStock ? Number(form.stock) : null;
    if (form.trackStock && (!Number.isInteger(stock) || stock < 0)) { setError('Informe a quantidade em estoque (número inteiro).'); return; }
    const prep = form.prepMinutes === '' ? null : Number(form.prepMinutes);
    if (prep != null && (!Number.isInteger(prep) || prep < 0)) { setError('Tempo de preparo inválido.'); return; }
    const body = { name: form.name.trim(), description: form.description.trim(), mode: form.mode, categoryId: form.categoryId ? Number(form.categoryId) : null, price,
      available: form.available, imageUrl: form.imageUrl.trim(), stock, prepMinutes: prep, allowNotes: form.allowNotes, customTextLabel: form.customTextLabel.trim(), kitchen: form.kitchen !== false,
      customTextRequired: form.customTextRequired, adminNotes: form.adminNotes.trim(), needsReview: form.needsReview, sortOrder: Number(form.sortOrder) || 0, optionGroups: groups };
    setBusy(true);
    try {
      await call(form.id ? `/admin/products/${form.id}` : '/admin/products', { method: form.id ? 'PUT' : 'POST', body });
      toast(form.id ? 'Produto atualizado. O catálogo já reflete a alteração.' : 'Produto cadastrado.');
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return <Modal title={form.id ? `Editar: ${initial.name}` : 'Novo produto'} onClose={onClose} size="lg"
    footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button><button type="submit" form="product-form" className="btn btn-primary" disabled={busy || uploading}>{busy ? 'Salvando...' : 'Salvar produto'}</button></>}>
    <form id="product-form" onSubmit={save} className="product-form">
      <section><h3>Informações</h3>
        <div className="grid-2">
          <Field label="Nome *"><input value={form.name} maxLength={160} required onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Catálogo"><select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value, categoryId: null })}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Categoria"><select value={form.categoryId || ''} onChange={(e) => set('categoryId', e.target.value || null)}><option value="">Sem categoria</option>{modeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (inativa)'}</option>)}</select></Field>
          <Field label="Ordem de exibição" hint="Menor aparece primeiro"><input type="number" min="0" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} /></Field>
        </div>
        <Field label="Descrição"><textarea rows={2} maxLength={2000} value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
      </section>
      <section><h3>Preço, disponibilidade e estoque</h3>
        <div className="grid-3">
          <Field label="Preço base *"><MoneyInput value={form.price} onChange={(v) => set('price', v)} /></Field>
          <Field label="Tempo de preparo (min)" hint="Opcional"><input type="number" min="0" max="600" value={form.prepMinutes} onChange={(e) => set('prepMinutes', e.target.value)} /></Field>
          {form.trackStock && <Field label="Quantidade em estoque"><input type="number" min="0" value={form.stock} onChange={(e) => set('stock', e.target.value)} /></Field>}
        </div>
        <div className="toggles">
          <Toggle checked={form.available} onChange={(v) => set('available', v)} label="Disponível no catálogo" />
          <Toggle checked={form.trackStock} onChange={(v) => set('trackStock', v)} label="Controlar estoque" description="Ao zerar, o produto sai do catálogo automaticamente." />
          {form.mode === 'snack' && <Toggle checked={form.kitchen !== false} onChange={(v) => set('kitchen', v)} label="Preparado na cozinha"
            description="Desligue para itens que saem prontos do balcão (salgado, café, bebida, doce): não aparecem na tela da cozinha." />}
        </div>
      </section>
      <section><h3>Imagem</h3>
        <div className="image-field">
          {form.imageUrl ? <img src={imageUrl(form.imageUrl)} alt="" /> : <span className="image-placeholder"><ImagePlus size={26} /></span>}
          <div>
            <label className="btn btn-outline btn-sm"><ImagePlus size={15} /> {uploading ? 'Enviando...' : 'Enviar foto'}<input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={upload} disabled={uploading} /></label>
            {form.imageUrl && <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('imageUrl', '')}>Remover</button>}
            <p className="muted small">Use fotos reais do produto. Sem foto, o catálogo mostra um ícone da categoria.</p>
          </div>
        </div>
      </section>
      <section><h3>Variações e adicionais</h3>
        <p className="muted small">Mínimo 0 = opcional. Mínimo 1 ou mais = obrigatório. Adicional vazio = grátis.</p>
        <OptionGroupsEditor groups={form.optionGroups} onChange={(groups) => set('optionGroups', groups)} />
      </section>
      <section><h3>Personalização e observações</h3>
        <Toggle checked={form.allowNotes} onChange={(v) => set('allowNotes', v)} label="Permitir observações do comprador" description="Ex.: sem cebola, bem passado." />
        <div className="grid-2">
          <Field label="Campo de personalização" hint="Ex.: Nome para gravação. Deixe vazio para não usar."><input value={form.customTextLabel} maxLength={80} onChange={(e) => set('customTextLabel', e.target.value)} /></Field>
          {form.customTextLabel && <Toggle checked={form.customTextRequired} onChange={(v) => set('customTextRequired', v)} label="Preenchimento obrigatório" />}
        </div>
      </section>
      <section><h3>Uso interno</h3>
        <Toggle checked={form.needsReview} onChange={(v) => set('needsReview', v)} label="Marcar para revisão" description="Mostra um alerta na lista até alguém conferir os dados." />
        <Field label="Anotações internas"><textarea rows={2} maxLength={1000} value={form.adminNotes} onChange={(e) => set('adminNotes', e.target.value)} /></Field>
      </section>
      {error && <p className="alert alert-error">{error}</p>}
    </form>
  </Modal>;
}

function CategoriesPanel({ categories, onChanged }) {
  const { call } = useAdmin();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', mode: 'snack' });
  const create = async (event) => {
    event.preventDefault();
    try { await call('/admin/categories', { method: 'POST', body: { name: form.name, mode: form.mode, sortOrder: categories.filter((c) => c.mode === form.mode).length + 1 } }); setForm({ ...form, name: '' }); toast('Categoria criada.'); onChanged(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const patch = async (category, body) => {
    try { await call(`/admin/categories/${category.id}`, { method: 'PATCH', body }); onChanged(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return <section className="panel">
    <h3>Categorias</h3>
    <form className="inline-form" onSubmit={create}>
      <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nova categoria" required minLength={2} maxLength={100} />
      <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <button className="btn btn-outline btn-sm">Criar</button>
    </form>
    {Object.entries(MODES).map(([mode, label]) => <div key={mode}>
      <h4>{label}</h4>
      <ul className="category-list">{categories.filter((c) => c.mode === mode).map((c) => <li key={c.id} className={c.active ? '' : 'inactive'}>
        <input type="number" min="0" className="order-input" defaultValue={c.sort_order} aria-label="Ordem" onBlur={(e) => Number(e.target.value) !== c.sort_order && patch(c, { sortOrder: Number(e.target.value) || 0 })} />
        <input className="name-input" defaultValue={c.name} aria-label="Nome" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && patch(c, { name: e.target.value.trim() })} />
        <small>{c.products} produto(s)</small>
        <button type="button" className={`btn btn-sm ${c.active ? 'btn-ghost' : 'btn-outline'}`} onClick={() => patch(c, { active: !c.active })}>{c.active ? 'Desativar' : 'Ativar'}</button>
      </li>)}</ul>
    </div>)}
  </section>;
}

export default function ProductsPage() {
  const { call } = useAdmin();
  const toast = useToast();
  const confirm = useConfirm();
  const [products, setProducts] = useState(null);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ mode: 'snack', q: '', archived: false, review: false });
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const [list, cats] = await Promise.all([call('/admin/products'), call('/admin/categories')]);
      setProducts(list); setCategories(cats); setError('');
    } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => (products || []).filter((p) => p.mode === filters.mode && p.archived === filters.archived && (!filters.review || p.needsReview)
    && (!filters.q || p.name.toLowerCase().includes(filters.q.toLowerCase()))), [products, filters]);
  const reviewCount = (products || []).filter((p) => p.needsReview && !p.archived).length;

  const patch = async (product, body, message) => {
    try { await call(`/admin/products/${product.id}`, { method: 'PATCH', body }); toast(message); load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const archive = async (product) => {
    const ok = await confirm({ title: `Arquivar "${product.name}"?`, message: 'O produto sai do catálogo e da lista principal. Pedidos antigos continuam com os dados originais. Você pode restaurá-lo depois.', confirmLabel: 'Arquivar' });
    if (ok) patch(product, { archived: true }, 'Produto arquivado.');
  };

  return <div className="admin-page">
    <header className="admin-page-head">
      <div><h1>Produtos</h1><p>Cadastro dos catálogos. As alterações aparecem imediatamente para os compradores.</p></div>
      <button type="button" className="btn btn-primary" onClick={() => setEditing(blankProduct(filters.mode))}><Plus size={16} /> Novo produto</button>
    </header>
    {reviewCount > 0 && <p className="alert alert-warning"><AlertTriangle size={17} /> {reviewCount} produto(s) com informações a conferir (marcados com "Revisar").
      <button type="button" className="btn btn-sm btn-outline" onClick={() => setFilters({ ...filters, review: !filters.review })}>{filters.review ? 'Ver todos' : 'Ver só esses'}</button></p>}
    <div className="filters-bar">
      <div className="segmented">{Object.entries(MODES).map(([k, v]) => <button type="button" key={k} className={filters.mode === k ? 'active' : ''} onClick={() => setFilters({ ...filters, mode: k })}>{v}</button>)}</div>
      <label className="search-field"><Search size={16} /><input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Buscar produto" /></label>
      <label className="check-line"><input type="checkbox" checked={filters.archived} onChange={(e) => setFilters({ ...filters, archived: e.target.checked })} /> Mostrar arquivados</label>
    </div>
    {error ? <ErrorState message={error} onRetry={load} /> : !products ? <Spinner /> : visible.length === 0
      ? <EmptyState title={filters.archived ? 'Nenhum produto arquivado' : 'Nenhum produto neste catálogo'}>{filters.mode === 'religious' && !filters.archived ? 'Enquanto não houver artigos ativos, o site mostra "Ainda não temos estoque".' : null}</EmptyState>
      : <div className="table-wrap"><table className="table products-table">
        <thead><tr><th>Produto</th><th>Categoria</th><th>Preço</th><th>Estoque</th><th>Situação</th><th /></tr></thead>
        <tbody>{visible.map((p) => <tr key={p.id}>
          <td><div className="product-cell"><ProductThumb product={p} size="sm" /><span><b>{p.name}</b>{p.optionGroups.length > 0 && <small>{p.optionGroups.map((g) => g.name).join(', ')}</small>}
            {p.needsReview && <small className="review-note" title={p.adminNotes}><AlertTriangle size={12} /> Revisar: {p.adminNotes.replace(/^Conferir:\s*/, '') || 'dados incompletos'}</small>}</span></div></td>
          <td>{p.category || '—'}</td>
          <td>{money(p.price)}</td>
          <td>{p.stock == null ? <span className="muted">não controlado</span> : p.stock === 0 ? <Badge tone="danger">Esgotado</Badge> : p.stock}</td>
          <td>{p.archived ? <Badge tone="neutral">Arquivado</Badge> : <button type="button" className={`switch-btn ${p.available ? 'on' : ''}`} onClick={() => patch(p, { available: !p.available }, p.available ? 'Produto indisponível.' : 'Produto disponível.')}>{p.available ? 'Disponível' : 'Indisponível'}</button>}</td>
          <td className="actions">
            <button type="button" className="icon-btn" title="Editar" onClick={() => setEditing(toForm(p))}><Pencil size={16} /></button>
            {p.archived ? <button type="button" className="icon-btn" title="Restaurar" onClick={() => patch(p, { archived: false }, 'Produto restaurado (indisponível até você ativar).')}><ArchiveRestore size={16} /></button>
              : <button type="button" className="icon-btn" title="Arquivar" onClick={() => archive(p)}><Archive size={16} /></button>}
          </td>
        </tr>)}</tbody></table></div>}
    <CategoriesPanel categories={categories} onChanged={load} />
    {editing && <ProductEditor initial={editing} categories={categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
  </div>;
}
