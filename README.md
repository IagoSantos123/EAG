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

## Modo local no evento (sem internet)

O sistema roda num notebook do salão, e os outros aparelhos usam pela rede Wi-Fi da sala. Não precisa de internet: o banco (PostgreSQL embutido), a API e as telas ficam todos nesse notebook, e a atualização entre balcão, cozinha e TV é instantânea.

**Montagem**
- **Notebook do salão (servidor):** roda `iniciar-local.bat`, vende pela Venda no balcão e liga a TV pelo HDMI (segunda tela) com o painel de senhas.
- **Notebook da cozinha:** abre no navegador o endereço que o servidor mostra (ex.: `http://192.168.43.10:3001`) e fica na tela Cozinha / Produção, com o som ligado.
- **Rede:** o roteador Wi-Fi (hotspot) de um celular entre as duas salas. Os dois notebooks entram nele. Funciona mesmo com o celular sem dados móveis. Também serve um roteador comum, sem internet.

**Antes do evento (com internet, uma vez)**
1. No notebook do salão: instalar o Node 22 e clonar este repositório.
2. Copiar `server/.env.local.example` para `server/.env.local` e preencher o administrador e a chave PIX.
3. Rodar `iniciar-local.bat` uma vez (instala tudo e prepara o banco) e fechar com Ctrl+C.
4. `npm run importar`: pede o e-mail e a senha do admin da nuvem e traz categorias, produtos, equipes e configurações do `eag-final.vercel.app`. Pode repetir sem duplicar, mas o estoque local passa a ser o da nuvem: não rode durante o evento.
5. Em Configurações → PIX, enviar a imagem do QR Code fixo.
6. Ensaiar com os dois notebooks no hotspot do celular.

**No dia**
1. Ligar o hotspot do celular e conectar os dois notebooks.
2. No notebook do salão: `iniciar-local.bat`. A janela mostra os endereços e precisa ficar aberta. Na primeira vez, o Windows pergunta sobre o firewall: permitir em **rede privada**. Sem isso, a cozinha não consegue abrir o endereço.
3. TV: abrir `http://localhost:3001/#/painel` numa janela arrastada para a TV, tocar em "Ativar som" e dar dois cliques para a tela cheia.
4. Cozinha: abrir o endereço da rede, entrar com o login de cozinha e ir em Cozinha / Produção.
5. Na nuvem (`eag-final.vercel.app`), ligar Configurações → Atendimento → **Pausar pedidos pelo site**, para ninguém pedir por lá.

**PIX no balcão:** na Venda no balcão, toque em **PIX** (o QR aparece na tela), confira o recebimento no celular e conclua. Assim o caixa fecha certo: PIX como PIX, não como dinheiro.

**Comanda impressa:** com a impressora térmica de 80 mm instalada como impressora padrão no aparelho em que está ligada, use o ícone de impressora no cartão do pedido ou ligue "Imprimir novos: sim" na cozinha. Para não abrir a janela de impressão a cada pedido, abra o Chrome por um atalho com `--kiosk-printing` no final do destino (ex.: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing http://192.168.43.10:3001/#/admin/cozinha`).

**Dados:** ficam em `.dados-local/` (fora do git). Pedidos e caixa do evento ficam só neste notebook: o relatório e o CSV saem pelo Financeiro. Para recomeçar do zero, apague essa pasta com o sistema fechado.

## Imagens

- Logos oficiais em `client/public/brand/` (extraídas das imagens fornecidas; resolução baixa — substitua pelos arquivos originais em alta quando possível).
- Fotos dos produtos em `client/public/products/` são **ilustrativas** (Unsplash, uso livre). Créditos em `docs/referencias/CREDITOS-FOTOS.md`.
- Cardápio de referência: `docs/referencias/cardapio-la-em-gracas.png`.
