# Lá em Graças Lanches · EAG Graças — Pedidos

Plataforma de pedidos da lanchonete **Lá em Graças Lanches** e da loja de **artigos religiosos** do EAG Graças.
Frontend React/Vite, API Node/Express e PostgreSQL (Neon). Interface em português, responsiva (celular, tablet e computador).

## Funcionalidades

**Comprador (site)**
- Cardápio com fotos, busca e barra de categorias; sacola separada por catálogo.
- Finalização com nome, telefone e equipe; modalidade **consumo no salão**, **retirada no balcão** ou **delivery** (endereço e taxa configurável — R$ 2,00 pelo cardápio).
- Pagamento por PIX (chave fixa, prazo e botão "Já paguei"), dinheiro (com troco), débito ou crédito. Fiado no autoatendimento é opcional (desligado por padrão).
- Acompanhamento do pedido com senha do dia, linha do tempo do preparo e situação do pagamento separadas, atualização automática.
- **Consultar pedido** pelo número (ou senha do dia) + telefone. Ninguém acessa pedido de outra pessoa pela URL.
- Artigos religiosos: enquanto não houver itens ativos, aparece "Ainda não temos estoque".

**Equipe (painel em `#/admin`)**
- **Venda no balcão**: registra o pedido, identifica o cliente (nome, telefone, equipe) e recebe em **uma ou mais formas** (PIX, dinheiro com troco, débito, crédito), deixa **no fiado** ou para pagar depois.
- **Pedidos**: filtros por período, catálogo, atendimento, etapa e pagamento; detalhes, histórico, edição dos dados do cliente, cancelamento com estorno.
- **Cozinha / Produção**: Kanban com 5 colunas (Novos → Em produção → Prontos → Aguardando retirada → Finalizados), botões e arrastar-e-soltar, correção com motivo, alerta de atraso, aviso sonoro opcional. Ao finalizar sem pagamento: **lançar no fiado** ou deixar pendente.
- **Fiados**: em aberto (agrupável por cliente, botão de cobrança por WhatsApp) e baixados. A **baixa** escolhe a(s) forma(s) de pagamento.
- **Financeiro**: indicadores (vendas registradas × recebido × a receber × fiado), conferência de PIX, recebimentos, lançamentos, **abertura/fechamento de caixa** com sangria, suprimento, conferência de dinheiro/PIX/cartão, histórico imprimível e CSV.
- **Produtos**: cadastro completo com foto, variações/adicionais configuráveis, estoque, disponibilidade e marcação "revisar".
- **Configurações** (PIX, formas de pagamento, atendimento, mesas, cozinha, contato, equipes) e **Usuários** por perfil.

## Perfis

| Perfil | Pode |
|---|---|
| Administrador | Tudo, inclusive produtos, configurações, usuários e ajustes em caixa fechado |
| Atendimento | Venda no balcão, pedidos, receber pagamentos, fiado, entregar/finalizar, cancelar pedidos não pagos |
| Financeiro | Financeiro, caixa, conferência de PIX, estornos, venda no balcão, fiado |
| Cozinha / Produção | Quadro da cozinha (todas as etapas), finalizar no fiado |

As permissões são verificadas no servidor a cada requisição (desativar um usuário corta o acesso na hora).

## Regras financeiras

- "Já paguei" do comprador **não** é recebimento: só o registro feito pela equipe conta.
- Recebimentos exigem **caixa aberto**; a soma das formas precisa fechar exatamente o valor em aberto; reenvios não duplicam.
- Fiado é valor **a receber**, não recebido. Finalizar pedido não marca como pago.
- Caixa fechado é imutável no próprio banco (gatilhos). Correções posteriores: ajuste do administrador com justificativa.

## Rodar localmente

Requisitos: Node 18.18+ (20+ recomendado) e PostgreSQL 14+.

1. Copie `server/.env.example` para `server/.env` (a API roda dentro de `server/` e lê o `.env` de lá) e preencha `DATABASE_URL`, `JWT_SECRET` (32+ caracteres) e o administrador inicial.
2. `npm install && npm install --prefix server && npm install --prefix client`
3. `npm run dev` → site em `http://localhost:5173`, API em `http://localhost:3001`.

Na primeira inicialização o servidor cria/atualiza as tabelas (migrações versionadas em `server/src/db.js`), cadastra o cardápio e cria o administrador. Nada é apagado.

## Testes

- API (banco real temporário): `TEST_DATABASE_ADMIN_URL=postgresql://usuario:senha@host:5432/postgres npm test`

## Produção (Vercel)

- Site estático (`client/dist`) + função `api/index.js` (mesmo app Express). `vercel.json` já configurado (região gru1).
- Variáveis: `DATABASE_URL` e `DATABASE_URL_UNPOOLED` (criadas pela integração Neon), `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `PAYMENT_PIX_*`, `APP_TIMEZONE`.
- PIX automático (Mercado Pago): `MP_ACCESS_TOKEN` (Access Token de produção, em "Suas integrações" no painel do Mercado Pago), `MP_WEBHOOK_SECRET` (assinatura secreta dos webhooks) e `MP_PAYER_EMAIL` (e-mail enviado como pagador, diferente do e-mail da conta). Opcional: `PUBLIC_URL` (endereço do site, para o webhook; na Vercel usa o domínio de produção). No painel, cadastre o webhook `https://<site>/api/mercadopago/webhook` com o evento "Pagamentos". Sem `MP_ACCESS_TOKEN`, o site volta para a chave PIX fixa com conferência manual.
- Na Vercel não há conexão persistente: as telas se atualizam sozinhas a cada ~8 segundos. Rodando com `npm start` em servidor próprio, a atualização é instantânea (SSE).
- Deploy: `vercel deploy --prod`.

## Imagens

- Logos oficiais em `client/public/brand/` (extraídas das imagens fornecidas; resolução baixa — substitua pelos arquivos originais em alta quando possível).
- Fotos dos produtos em `client/public/products/` são **ilustrativas** (Unsplash, uso livre). Créditos em `docs/referencias/CREDITOS-FOTOS.md`.
- Cardápio de referência: `docs/referencias/cardapio-la-em-gracas.png`.
