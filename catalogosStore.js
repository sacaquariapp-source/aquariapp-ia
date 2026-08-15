const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'catalogos');

const NOMES = [
  'especies',
  'faunaBrasileira',
  'faunaComplementar',
  'doencas',
  'produtos',
  'flora',
  'algas',
  'microorganismos',
];

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

const CHAVE_POR_NOME = {
  especies: (x) => normalizar(x.nomeCientifico || x.nomeComum || x.id),
  faunaBrasileira: (x) => normalizar(x.nomeCientifico || x.nomeComum || x.id),
  faunaComplementar: (x) => normalizar(x.nomeCientifico || x.nomeComum || x.id),
  doencas: (x) => normalizar(x.id || x.nome),
  produtos: (x) => normalizar(x.id || `${x.marca || ''} ${x.nome || ''}`),
  flora: (x) => normalizar(x.nomeCientifico || x.nomeComum || x.id),
  algas: (x) => normalizar(x.id || x.nome),
  microorganismos: (x) => normalizar(x.id || x.nome),
};

function chaveDe(nome, item) {
  const fn = CHAVE_POR_NOME[nome] || ((x) => JSON.stringify(x));
  return fn(item);
}

function arquivo(nome) {
  return path.join(DIR, `${nome}.json`);
}

function ler(nome) {
  try {
    return JSON.parse(fs.readFileSync(arquivo(nome), 'utf8'));
  } catch (e) {
    return [];
  }
}

function salvar(nome, lista) {
  try {
    fs.writeFileSync(arquivo(nome), JSON.stringify(lista, null, 1), 'utf8');
  } catch (e) {
    console.error(`Falha ao salvar catálogo ${nome}:`, e.message);
  }
}

function listar(nome) {
  return ler(nome);
}

function adicionar(nome, item) {
  const lista = ler(nome);
  const chave = chaveDe(nome, item);
  const idx = lista.findIndex((x) => chaveDe(nome, x) === chave);
  if (idx !== -1) {
    lista[idx] = { ...lista[idx], ...item };
  } else {
    lista.push(item);
  }
  salvar(nome, lista);
  return item;
}

function atualizar(nome, chaveBusca, item) {
  const lista = ler(nome);
  const idx = lista.findIndex((x) => chaveDe(nome, x) === chaveBusca);
  if (idx === -1) return null;
  lista[idx] = { ...lista[idx], ...item };
  salvar(nome, lista);
  return lista[idx];
}

function remover(nome, chaveBusca) {
  const lista = ler(nome);
  const nova = lista.filter((x) => chaveDe(nome, x) !== chaveBusca);
  if (nova.length === lista.length) return false;
  salvar(nome, nova);
  return true;
}

module.exports = { NOMES, chaveDe, listar, adicionar, atualizar, remover };
