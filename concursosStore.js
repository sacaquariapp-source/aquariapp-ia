const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'concursos.json');

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
    console.error('Falha ao salvar concursos:', e.message);
  }
}

// --- Configuração do concurso ativo ---
function obterConfig() {
  const dados = ler();
  return dados.config || null;
}

function salvarConfig(config) {
  const dados = ler();
  dados.config = config;
  salvar(dados);
  return config;
}

// --- Inscrições ---
function listarInscricoes() {
  const dados = ler();
  return Array.isArray(dados.inscricoes) ? dados.inscricoes : [];
}

function obterInscricao(id) {
  return listarInscricoes().find((i) => i.id === id) || null;
}

// Inscrição imutável: após criada, não há edição nem exclusão.
function criarInscricao(dados) {
  const inscricoes = listarInscricoes();
  const inscricao = {
    id: `ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    criadoEm: Date.now(),
    votos: 0,
    votantes: [],
    ...dados,
  };
  inscricoes.push(inscricao);
  const store = ler();
  store.inscricoes = inscricoes;
  salvar(store);
  return inscricao;
}

// --- Votação ---
function registrarVoto(inscricaoId, dispositivoId) {
  const inscricoes = listarInscricoes();
  const idx = inscricoes.findIndex((i) => i.id === inscricaoId);
  if (idx === -1) return { ok: false, motivo: 'Inscrição não encontrada.' };
  const inscricao = inscricoes[idx];
  const votantes = Array.isArray(inscricao.votantes) ? inscricao.votantes : [];
  const norm = String(dispositivoId || '').trim();
  if (!norm) return { ok: false, motivo: 'Dispositivo inválido.' };
  if (votantes.includes(norm)) {
    return { ok: false, motivo: 'JÁ_VOTOU', jaVotou: true };
  }
  votantes.push(norm);
  inscricoes[idx] = { ...inscricao, votantes, votos: votantes.length };
  const store = ler();
  store.inscricoes = inscricoes;
  salvar(store);
  return { ok: true, inscricao: inscricoes[idx] };
}

function definirGanhador(inscricaoId) {
  const inscricoes = listarInscricoes();
  const idx = inscricoes.findIndex((i) => i.id === inscricaoId);
  if (idx === -1) return null;
  const store = ler();
  store.ganhador = { inscricaoId, declaradoEm: Date.now() };
  salvar(store);
  return { inscricaoId, inscricao: inscricoes[idx] };
}

function obterGanhador() {
  const dados = ler();
  if (!dados.ganhador) return null;
  const inscricao = obterInscricao(dados.ganhador.inscricaoId);
  if (!inscricao) return null;
  return { inscricaoId: inscricao.id, inscricao, declaradoEm: dados.ganhador.declaradoEm };
}

module.exports = {
  obterConfig,
  salvarConfig,
  listarInscricoes,
  obterInscricao,
  criarInscricao,
  registrarVoto,
  definirGanhador,
  obterGanhador,
};
