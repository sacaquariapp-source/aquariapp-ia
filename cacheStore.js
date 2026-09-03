const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARQUIVO = path.join(__dirname, 'identificacoes-cache.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const MAX_ENTRADAS = 500;

function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    const dados = JSON.parse(raw);
    return dados && typeof dados === 'object' ? dados : {};
  } catch (e) {
    return {};
  }
}

function salvar(dados) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar cache de identificações:', e.message);
  }
}

// Hash SHA-256 da imagem base64 (chave estável para a mesma foto).
function gerarHash(base64) {
  try {
    return crypto.createHash('sha256').update(String(base64 || '')).digest('hex');
  } catch (e) {
    return '';
  }
}

// Retorna o resultado em cache se válido (não expirado), senão null.
function buscar(hash) {
  if (!hash) return null;
  const dados = ler();
  const entrada = dados[hash];
  if (!entrada) return null;
  const agora = Date.now();
  if (agora - entrada.timestamp > TTL_MS) return null;
  entrada.hits = (entrada.hits || 0) + 1;
  entrada.ultimoAcesso = agora;
  salvar(dados);
  return entrada.resultado || null;
}

// Salva o resultado no cache, podando entradas antigas/expiradas.
function salvarResultado(hash, resultado) {
  if (!hash || !resultado) return;
  const dados = ler();
  const agora = Date.now();
  // Remove entradas expiradas.
  const limpo = {};
  let contagem = 0;
  for (const [h, e] of Object.entries(dados)) {
    if (agora - e.timestamp <= TTL_MS && contagem < MAX_ENTRADAS) {
      limpo[h] = e;
      contagem += 1;
    }
  }
  limpo[hash] = { resultado, timestamp: agora, hits: 1, ultimoAcesso: agora };
  salvar(limpo);
}

module.exports = { gerarHash, buscar, salvarResultado };