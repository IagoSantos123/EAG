# AGENTS.md — instruções para agentes de código (Claude Code, Antigravity, OpenCode...)

Lido automaticamente pelo Antigravity/OpenCode. O Claude Code lê via `CLAUDE.md` (que importa este arquivo).

## Projeto
Plataforma de pedidos da lanchonete **Lá em Graças Lanches** (EAG Graças). Veja o `README.md` para funcionalidades e regras.
- `client/` — React 18 + Vite (JS puro, sem TypeScript). Loja em `src/shop/`, painel em `src/admin/`, utilitários em `src/lib/`.
- `server/` — Node + Express + `pg` + `zod`. Rotas em `src/routes/`, regras em `src/lib/`, migrações versionadas em `src/db.js`.
- `api/index.js` — mesma app Express como função da Vercel.
- Interface, mensagens de commit e comentários **em português**.

## Como rodar
- Cada agente roda na **sua worktree** com `rodar-agente.bat` (modo local, banco embutido próprio, porta própria). Nunca use `npm run dev` (pode apontar para o banco da nuvem via `server/.env`).
- Build do front: `npm run build`. Testes da API: `npm test` (pasta `server/test/`, `node --test`).

## Regras invioláveis
1. **Não toque** em `.dados-local/`, `.dados-teste/`, `.evento/`, `.pgdata/` nem em arquivos `.env*` (exceto `.env.example`/`.env.local.example`).
2. **Nunca rode** `npm run importar`, `npm run lancar-nuvem`, nem nada que fale com Neon/Vercel/Mercado Pago de produção.
3. Não faça `push`, `merge` ou `rebase` na `main`. Trabalhe só na sua branch; quem integra é o João.
4. Mexa **apenas nos caminhos listados na sua task** em `TASKS.md`. Precisou de outro arquivo? Pare e explique no resumo final.
5. Não edite `TASKS.md` (o João atualiza na `main`).
6. Regras financeiras do README são sagradas: "Já paguei" não é recebimento; recebimento exige caixa aberto; soma das formas fecha o valor; fiado é a receber; caixa fechado é imutável. Não altere esse comportamento sem a task pedir explicitamente.
7. Migrações em `server/src/db.js` são só **adicionadas**, nunca editadas ou apagadas.

## Fluxo de uma task
1. Leia a task em `TASKS.md` (procure a com o seu nome em "dono").
2. Faça a mudança em commits pequenos: `T<n>: descrição curta` (ex.: `T1: testes de recebimento com caixa fechado`).
3. Antes de terminar: `npm run build` sem erro e, se mexeu no server, `npm test` passando.
4. Termine com um resumo: o que mudou, arquivos tocados, como testar manualmente, riscos/pendências.
