import React, { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { ErrorState, Field, MoneyInput, Spinner, Toggle, useToast } from '../components/ui.jsx';
import { imageUrl, parseMoney } from '../lib/api.js';
import { useAdmin } from './context.js';

function Section({ title, description, children, onSave, busy }) {
  return <section className="panel settings-section">
    <header><div><h3>{title}</h3>{description && <p className="muted small">{description}</p>}</div></header>
    {children}
    {onSave && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onSave}><Save size={15} /> Salvar</button>}
  </section>;
}

function TeamsPanel() {
  const { call } = useAdmin();
  const toast = useToast();
  const [teams, setTeams] = useState([]);
  const [name, setName] = useState('');
  const load = useCallback(() => call('/admin/teams').then(setTeams).catch((err) => toast(err.message, 'error')), [call, toast]);
  useEffect(() => { load(); }, [load]);
  const create = async (event) => {
    event.preventDefault();
    try { await call('/admin/teams', { method: 'POST', body: { name } }); setName(''); toast('Equipe criada.'); load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const toggle = async (team) => {
    try { await call(`/admin/teams/${team.id}`, { method: 'PATCH', body: { active: !team.active } }); load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return <Section title="Equipes" description="Aparecem na finalização do pedido. Equipes inativas deixam de aparecer, mas continuam nos pedidos antigos.">
    <form className="inline-form" onSubmit={create}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova equipe" required minLength={2} maxLength={100} /><button className="btn btn-outline btn-sm">Criar</button></form>
    <ul className="category-list">{teams.map((team) => <li key={team.id} className={team.active ? '' : 'inactive'}><span className="name-input">{team.name}</span>
      <button type="button" className={`btn btn-sm ${team.active ? 'btn-ghost' : 'btn-outline'}`} onClick={() => toggle(team)}>{team.active ? 'Desativar' : 'Ativar'}</button></li>)}</ul>
  </Section>;
}

export default function SettingsPage() {
  const { call } = useAdmin();
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [fee, setFee] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (data) => { setSettings(data); setFee(data.service.delivery_fee.toFixed(2).replace('.', ',')); };
  const load = useCallback(async () => {
    try { apply(await call('/admin/settings')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);

  const save = async (keys) => {
    const body = Object.fromEntries(keys.map((key) => [key, settings[key]]));
    if (body.service) {
      const value = fee === '' ? 0 : parseMoney(fee);
      if (Number.isNaN(value) || value < 0) { toast('Taxa de entrega inválida.', 'error'); return; }
      body.service = { ...body.service, delivery_fee: value, table_count: Number(body.service.table_count) || 0 };
    }
    setBusy(true);
    try { apply(await call('/admin/settings', { method: 'PUT', body })); toast('Configurações salvas.'); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const set = (key, field, value) => setSettings((current) => ({ ...current, [key]: { ...current[key], [field]: value } }));

  // QR Code fixo do PIX: enviado sem redimensionar (comprimir pode deixar o QR ilegível).
  const uploadQr = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Envie uma imagem PNG, JPG ou WEBP.', 'error'); return; }
    if (file.size > 1_400_000) { toast('Imagem muito grande: use um print ou foto menor que 1,4 MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await call('/admin/images', { method: 'POST', body: { dataUrl: reader.result } });
        set('pix', 'qr_image', result.url);
        toast('QR carregado. Toque em Salvar para usar no balcão e no painel.', 'info');
      } catch (err) { toast(err.message, 'error'); }
    };
    reader.readAsDataURL(file);
  };

  if (error) return <div className="admin-page"><ErrorState message={error} onRetry={load} /></div>;
  if (!settings) return <div className="admin-page"><Spinner /></div>;
  const { pix, payment_methods: methods, service, kitchen, contact } = settings;

  return <div className="admin-page">
    <header className="admin-page-head"><div><h1>Configurações</h1><p>Ajustes de pagamento, atendimento e operação.</p></div></header>
    <div className="settings-grid">
      <Section title="PIX" description="Chave fixa exibida ao comprador. O sistema não consulta o banco: a confirmação é manual pelo financeiro." onSave={() => save(['pix', 'payment_deadline_minutes'])} busy={busy}>
        <Field label="Chave PIX"><input value={pix.key} maxLength={250} onChange={(e) => set('pix', 'key', e.target.value)} /></Field>
        <div className="grid-2">
          <Field label="Tipo da chave"><input value={pix.type} maxLength={60} onChange={(e) => set('pix', 'type', e.target.value)} /></Field>
          <Field label="Prazo para pagar (minutos)" hint="De 5 a 120"><input type="number" min="5" max="120" value={settings.payment_deadline_minutes} onChange={(e) => setSettings({ ...settings, payment_deadline_minutes: Number(e.target.value) })} /></Field>
          <Field label="Beneficiário"><input value={pix.beneficiary} maxLength={120} onChange={(e) => set('pix', 'beneficiary', e.target.value)} /></Field>
          <Field label="Cidade"><input value={pix.city} maxLength={80} onChange={(e) => set('pix', 'city', e.target.value)} /></Field>
        </div>
        <Field label="Orientações ao comprador"><textarea rows={2} maxLength={1000} value={pix.instructions} onChange={(e) => set('pix', 'instructions', e.target.value)} /></Field>
        <div className="field">
          <span>QR Code fixo do PIX</span>
          <div className="qr-setting">
            {pix.qr_image ? <img src={imageUrl(pix.qr_image)} alt="QR Code do PIX" /> : <span className="muted small">Nenhum QR enviado.</span>}
            <label className="btn btn-outline btn-sm">Enviar imagem<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={uploadQr} /></label>
            {pix.qr_image && <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('pix', 'qr_image', '')}>Remover</button>}
          </div>
          <small className="hint">Aparece na Venda no balcão ao escolher PIX e no painel de senhas da TV.</small>
        </div>
      </Section>

      <Section title="Formas de pagamento" description="PIX fica sempre disponível (quando há chave configurada ou o Mercado Pago está ligado; com o Mercado Pago, o PIX do site é gerado e confirmado automaticamente). Desativar uma forma remove a opção do site e do registro de recebimentos." onSave={() => save(['payment_methods'])} busy={busy}>
        <Toggle checked={methods.cash} onChange={(v) => set('payment_methods', 'cash', v)} label="Dinheiro" />
        <Toggle checked={methods.debit} onChange={(v) => set('payment_methods', 'debit', v)} label="Cartão de débito" />
        <Toggle checked={methods.credit} onChange={(v) => set('payment_methods', 'credit', v)} label="Cartão de crédito" />
      </Section>

      <Section title="Atendimento" description="Modalidades oferecidas na finalização do pedido." onSave={() => save(['service'])} busy={busy}>
        <Toggle checked={service.dine_in} onChange={(v) => set('service', 'dine_in', v)} label="Consumo no salão" />
        <Toggle checked={service.pickup} onChange={(v) => set('service', 'pickup', v)} label="Retirada no balcão" />
        <Toggle checked={service.delivery} onChange={(v) => set('service', 'delivery', v)} label="Delivery (GRASFOOD)" />
        <div className="grid-2">
          <Field label="Taxa de entrega" hint="Somada ao total dos pedidos delivery"><MoneyInput value={fee} onChange={setFee} /></Field>
          <Field label="Quantidade de mesas" hint="0 = número livre"><input type="number" min="0" max="500" value={service.table_count} disabled={!service.tables_enabled} onChange={(e) => set('service', 'table_count', e.target.value)} /></Field>
        </div>
        <Toggle checked={service.tables_enabled} onChange={(v) => set('service', 'tables_enabled', v)} label="Pedir número da mesa no salão" description="Quando ativo, o comprador informa a mesa ao escolher consumo no salão." />
        <Toggle checked={Boolean(service.site_paused)} onChange={(v) => set('service', 'site_paused', v)} label="Pausar pedidos pelo site"
          description="Use quando o evento estiver rodando no modo local (sem internet): o site mostra 'Faça seu pedido no balcão' e não aceita pedidos." />
        <Field label="Orientação — salão"><input value={service.dine_in_instructions} maxLength={500} onChange={(e) => set('service', 'dine_in_instructions', e.target.value)} /></Field>
        <Field label="Orientação — retirada"><input value={service.pickup_instructions} maxLength={500} onChange={(e) => set('service', 'pickup_instructions', e.target.value)} /></Field>
        <Field label="Orientação — delivery"><input value={service.delivery_instructions} maxLength={500} onChange={(e) => set('service', 'delivery_instructions', e.target.value)} /></Field>
      </Section>

      <Section title="Cozinha" onSave={() => save(['kitchen'])} busy={busy}>
        <Toggle checked={kitchen.require_pix_confirmation} onChange={(v) => set('kitchen', 'require_pix_confirmation', v)} label="Exigir PIX confirmado para iniciar a produção"
          description="Pedidos em dinheiro ou cartão (pagos no caixa/na entrega) podem ser produzidos antes do pagamento." />
      </Section>

      <Section title="Contato" description="Telefone exibido no rodapé e no acompanhamento (ex.: delivery GRASFOOD)." onSave={() => save(['contact'])} busy={busy}>
        <Field label="Telefone / WhatsApp"><input value={contact.phone} maxLength={40} onChange={(e) => set('contact', 'phone', e.target.value)} placeholder="(83) 99999-0000" /></Field>
      </Section>

      <TeamsPanel />
    </div>
  </div>;
}
