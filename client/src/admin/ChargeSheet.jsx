// Comanda de cobrança pronta para divulgar: prévia da imagem, copiar/baixar a imagem e copiar o texto do WhatsApp.
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Image as ImageIcon } from 'lucide-react';
import { Modal, Spinner, useToast } from '../components/ui.jsx';
import { money } from '../lib/api.js';
import { useAdmin } from './context.js';
import { chargeImage, chargeText } from './cobranca.js';

const fileName = (text) => `fiado-${text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`;

export default function ChargeSheet({ charges, title, onClose }) {
  const { call } = useAdmin();
  const toast = useToast();
  const [pix, setPix] = useState(null);
  const [blob, setBlob] = useState(null);
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : ''), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  useEffect(() => { call('/payment-info').then(setPix).catch(() => setPix({})); }, [call]);
  useEffect(() => {
    if (!pix) return;
    let alive = true;
    chargeImage(charges, { title, pix }).then((result) => { if (alive) setBlob(result); });
    return () => { alive = false; };
  }, [charges, title, pix]);

  const text = chargeText(charges, { title, pix: pix || {} });
  const total = charges.reduce((sum, c) => sum + c.balance, 0);
  const name = title || charges[0]?.name || 'fiado';

  const copyText = async () => {
    try { await navigator.clipboard.writeText(text); toast('Texto copiado. Cole no grupo do WhatsApp.'); }
    catch { toast('Não deu para copiar. Selecione o texto e copie.', 'error'); }
  };
  const copyImage = async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Imagem copiada. Cole no grupo do WhatsApp (Ctrl+V).'); }
    catch { toast('Este navegador não copia imagem. Use "Baixar imagem".', 'error'); }
  };
  const download = () => {
    const link = document.createElement('a');
    link.href = url; link.download = fileName(name); link.click();
  };

  return <Modal title={title || `Comanda de ${charges[0]?.name}`} subtitle={`${charges.length} ${charges.length === 1 ? 'pessoa' : 'pessoas'} · ${money(total)} em aberto`} onClose={onClose} size="lg" className="charge-sheet"
    footer={<>
      <button type="button" className="btn btn-ghost" onClick={copyText}><Copy size={16} /> Copiar texto</button>
      <button type="button" className="btn btn-outline" disabled={!blob} onClick={download}><Download size={16} /> Baixar imagem</button>
      <button type="button" className="btn btn-primary" disabled={!blob} onClick={copyImage}><ImageIcon size={16} /> Copiar imagem</button>
    </>}>
    <div className="charge-grid">
      <div className="charge-preview">{url ? <img src={url} alt={`Comanda de fiado: ${name}`} /> : <Spinner />}</div>
      <label className="field charge-text"><span>Texto para o WhatsApp</span><textarea readOnly value={text} onFocus={(e) => e.target.select()} /></label>
    </div>
  </Modal>;
}
