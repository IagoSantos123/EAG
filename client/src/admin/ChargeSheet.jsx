// Comanda de cobrança do fiado pronta para divulgar (uma pessoa ou a equipe inteira), com a chave PIX.
import React, { useCallback, useEffect, useState } from 'react';
import { money } from '../lib/api.js';
import { useAdmin } from './context.js';
import { chargeImages, chargeText } from './cobranca.js';
import ShareSheet from './ShareSheet.jsx';

export default function ChargeSheet({ charges, title, onClose }) {
  const { call } = useAdmin();
  const [pix, setPix] = useState(null);
  useEffect(() => { call('/payment-info').then(setPix).catch(() => setPix({})); }, [call]);
  const makeImages = useCallback(() => chargeImages(charges, { title, pix }), [charges, title, pix]);

  const total = charges.reduce((sum, c) => sum + c.balance, 0);
  return <ShareSheet title={title || `Comanda de ${charges[0]?.name}`} fileBase={`fiado-${title || charges[0]?.name || ''}`}
    subtitle={`${charges.length} ${charges.length === 1 ? 'pessoa' : 'pessoas'} · ${money(total)} em aberto`}
    text={chargeText(charges, { title, pix: pix || {} })} makeImages={pix ? makeImages : null} onClose={onClose} />;
}
