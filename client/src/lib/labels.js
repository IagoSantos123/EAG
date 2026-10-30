// Rótulos exibidos na interface (o banco guarda códigos estáveis).

export const PRODUCTION_STEPS = ['new', 'in_production', 'ready', 'awaiting_pickup', 'finalized'];

export const PRODUCTION_LABELS = {
  new: 'Novos pedidos',
  in_production: 'Em produção',
  ready: 'Prontos',
  awaiting_pickup: 'Aguardando retirada',
  finalized: 'Finalizados'
};

export const PRODUCTION_SHORT = {
  new: 'Novo', in_production: 'Em produção', ready: 'Pronto', awaiting_pickup: 'Aguardando retirada', finalized: 'Finalizado'
};

// Texto do botão que avança o pedido para a etapa indicada.
export const ADVANCE_LABELS = {
  in_production: 'Iniciar produção',
  ready: 'Marcar como pronto',
  awaiting_pickup: 'Disponibilizar',
  finalized: 'Confirmar entrega'
};

// Linha do tempo vista pelo comprador (varia conforme a modalidade).
export function customerStepLabel(step, serviceType) {
  const delivery = serviceType === 'delivery';
  return {
    new: 'Pedido recebido',
    in_production: 'Em produção',
    ready: 'Pedido pronto',
    awaiting_pickup: delivery ? 'Saiu para entrega' : 'Aguardando retirada',
    finalized: delivery ? 'Entregue' : 'Pedido finalizado'
  }[step];
}

export const PAYMENT_STATUS = {
  awaiting_payment: { label: 'Aguardando pagamento', tone: 'warning' },
  pending_review: { label: 'PIX em conferência', tone: 'info' },
  partial: { label: 'Pago parcialmente', tone: 'warning' },
  confirmed: { label: 'Pago', tone: 'success' },
  refunded: { label: 'Estornado', tone: 'neutral' }
};

export const ORDER_STATUS = {
  active: { label: 'Ativo', tone: 'success' },
  cancelled: { label: 'Cancelado', tone: 'danger' },
  expired: { label: 'Expirado', tone: 'neutral' }
};

export const PAYMENT_METHODS = {
  pix: 'PIX', cash: 'Dinheiro', debit: 'Cartão de débito', credit: 'Cartão de crédito', fiado: 'Fiado'
};

export const SERVICE_TYPES = {
  dine_in: 'Consumo no salão', delivery: 'Delivery', pickup: 'Retirada no balcão'
};

export const MODES = { snack: 'Lanchonete', religious: 'Artigos religiosos' };

export const ROLES = {
  admin: { label: 'Administrador', description: 'Acesso total: produtos, categorias, equipes, configurações e usuários.' },
  kitchen: { label: 'Cozinha / Produção', description: 'Vê e movimenta os pedidos no quadro da cozinha.' },
  finance: { label: 'Financeiro', description: 'Confere PIX, registra recebimentos e faz abertura/fechamento de caixa.' },
  operator: { label: 'Atendimento', description: 'Consulta pedidos, entrega/finaliza pedidos prontos e cancela pedidos não pagos.' }
};
