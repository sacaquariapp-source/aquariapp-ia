const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'feedback-identificacao.json');
const MAX_REGISTROS = 2000;

function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    const dados = JSON.parse(raw);
    return Array.isArray(dados) ? dados : [];
  } catch (e) {
    return [];
  }
}

function salvar(lista) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar feedback-identificacao.json:', e.message);
  }
}

// Registra um feedback de erro de identificação vindo do app tester.
// Campos: hashImagem, resultadoErrado {nomeComum, nomeCientifico, provedor,
// confianca}, nomeCorretoSugerido, dispositivoId?, origem?
function registrar({ hashImagem, resultadoErrado, nomeCorretoSugerido, dispositivoId, origem }) {
  const lista = ler();
  const registro = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    recebidoEm: Date.now(),
    hashImagem: String(hashImagem || '').slice(0, 64) || null,
    resultadoErrado: resultadoErrado || null,
    nomeCorretoSugerido: String(nomeCorretoSugerido || '').trim().slice(0, 120),
    dispositivoId: String(dispositivoId || '').trim().slice(0, 120) || null,
    origem: String(origem || '').trim().slice(0, 40) || null,
    revisado: false,
  };
  lista.unshift(registro);
  salvar(lista.slice(0, MAX_REGISTROS));
  return registro;
}

function listar() {
  return ler();
}

function resumo() {
  const lista = ler();
  const porNome = {};
  for (const r of lista) {
    const chave = (r.nomeCorretoSugerido || 'indefinido').toLowerCase();
    porNome[chave] = (porNome[chave] || 0) + 1;
  }
  return {
    total: lista.length,
    pendentesRevisao: lista.filter((r) => !r.revisado).length,
    porNomeSugerido: porNome,
  };
}

module.exports = { registrar, listar, resumo };
