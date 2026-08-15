const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'trial.json');

// Guarda os dispositivos que já usaram o teste freemium. O app reserva o teste
// por dispositivo; se o dispositivo já usou o teste em qualquer conta, o app
// não concede um novo período. Persistido em disco (Render free não garante
// disco permanente entre restarts — aceitável para o teste).
function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function salvar(dados) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar trial.json:', e.message);
  }
}

// Reserva o teste para um dispositivo. Retorna:
//   { liberado: true, motivo: 'primeira_vez' }   → pode usar o teste
//   { liberado: false, motivo: 'ja_usou' }       → dispositivo já usou
function reservar(dispositivoId) {
  const id = String(dispositivoId || '').trim();
  if (!id) return { liberado: true, motivo: 'sem_id' };
  const dados = ler();
  const jaUsados = Array.isArray(dados.dispositivos) ? dados.dispositivos : [];
  if (jaUsados.includes(id)) {
    return { liberado: false, motivo: 'ja_usou' };
  }
  salvar({ dispositivos: [...jaUsados, id], atualizadoEm: new Date().toISOString() });
  return { liberado: true, motivo: 'primeira_vez' };
}

function listar() {
  const dados = ler();
  return {
    dispositivos: Array.isArray(dados.dispositivos) ? dados.dispositivos : [],
    atualizadoEm: dados.atualizadoEm || null,
  };
}

function remover(dispositivoId) {
  const dados = ler();
  const nova = (Array.isArray(dados.dispositivos) ? dados.dispositivos : []).filter(
    (id) => id !== dispositivoId
  );
  if (nova.length === (Array.isArray(dados.dispositivos) ? dados.dispositivos : []).length) {
    return false;
  }
  salvar({ ...dados, dispositivos: nova });
  return true;
}

module.exports = { reservar, listar, remover };
