# AquarIApp — Deploy do Backend de IA (passo a passo simples)

Este pacote é o **servidor de IA** do AquarIApp (Node/Express). Ele guarda as
chaves OpenAI/Gemini/PlantNet e responde às rotas que o app usa (`/identify`,
`/diagnostico`, `/catalogos`, `/ofertas`, `/concursos`, `/tester/validar` etc.).

Para o app funcionar 24/7 sem depender da sua máquina, suba ESTA pasta em um
host Node grátis. A opção mais fácil é o **Render.com** (tier free).

---

## Passo a passo — Render.com (grátis, fácil)

### 1. Crie um repositório Git (GitHub)
1. Acesse https://github.com e crie um repositório **privado** (ex.: `aquariapp-ia`).
2. Suba o conteúdo **desta pasta** (`deploy-backend`) para esse repositório.
   - Se não sabe usar Git, a maneira mais simples: no GitHub, clique em
     **"uploading an existing file"** e arraste os arquivos desta pasta
     (sem `node_modules`).

### 2. Crie o Web Service no Render
1. Acesse https://render.com e crie uma conta (grátis).
2. Clique em **New** → **Web Service**.
3. Conecte o repositório `aquariapp-ia`.
4. O Render detecta o `render.yaml` e preenche quase tudo sozinho. Confirme:
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `node index.js`
5. Antes de criar, defina as variáveis de ambiente (aba "Environment"):
   - `OPENAI_API_KEY` = sua chave OpenAI
   - `GEMINI_API_KEY` = sua chave Gemini
   - `GEMINI_MODEL` = `gemini-2.5-flash`
   - `PLANTNET_API_KEY` = sua chave PlantNet
   - `ADMIN_KEY` = a MESMA chave do seu `server/.env` (para o painel admin)
   - `ALLOWED_ORIGINS` = URL do front publicado (ex.: `https://aquariapp.netlify.app`)
   - `PUBLIC_BASE_URL` = a URL deste backend (ex.: `https://aquariapp-ia.onrender.com`)
6. Clique em **Create Web Service**. Aguarde o deploy (1-3 min).

### 3. Copie a URL do backend
Depois de publicado, o Render te dá uma URL do tipo
`https://aquariapp-ia.onrender.com`. **Guarde essa URL** — você vai precisar
para o front-end.

> ⚠️ No plano free do Render, o serviço "dorme" após ~15 min sem uso e acorda
> na primeira chamada (leva ~30-50s). É aceitável para testes com 6 pessoas.

---

## Passo a passo — Front-end (app web)

1. Publique a pasta `AquarIApp/deploy/` num host estático grátis:
   - **Netlify:** acesse https://app.netlify.com/drop e arraste a pasta `deploy/`.
2. Você terá uma URL tipo `https://xxxx.netlify.app`.
3. Defina `ALLOWED_ORIGINS` no backend com essa URL (se ainda não fez).
4. Rebuild do front apontando para o backend:

   ```sh
   cd /home/isabella/aquariapp-dev
   EXPO_PUBLIC_IA_URL=https://aquariapp-ia.onrender.com npx expo export --platform web
   ```

5. Copie o novo `dist/` para `deploy/` e publique de novo no Netlify.

---

## Alternativa sem Git (mais fácil ainda)

Se não quiser mexer com GitHub:
- **Backend:** use https://render.com com **"Upload"**? (Render não aceita upload
  direto; precisa de Git ou Blueprint). Alternativa que aceita upload direto:
  **https://railway.app** (comando `railway up`) ou **https://glitch.com**
  (colar os arquivos e rodar Node). O Glitch é o mais simples para quem não
  programa: crie um projeto Node, apague os arquivos de exemplo e cole os
  desta pasta, coloque as variáveis em `.env`, e clique em "Run".
- **Front:** Netlify Drop continua sendo o mais fácil (arrastar pasta).

---

## Verificação rápida

Depois do backend no ar, teste no navegador:

```
https://SEU_BACKEND_URL/catalogos
```

Deve retornar um JSON de catálogos. E:

```
https://SEU_BACKEND_URL/tester/validar
```

(Método POST com `{"dispositivoId":"teste"}`) deve retornar `{"ok":true}`.

---

## Notas importantes

- As chaves de IA **ficam no backend** (nunca no app). Isso é o correto.
- `ADMIN_KEY` do backend publicado deve ser **diferente da de dev** ou a mesma —
  o que você preferir. Use um valor longo.
- O plano free do Render tem limite de 512MB de RAM e o serviço dorme; suficiente
  para o teste. Para produção real, considere um plano pago.
