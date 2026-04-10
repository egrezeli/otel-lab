'use strict';
const axios = require('axios');

const BASE_URL = process.env.API_URL || 'http://api-gateway:3000';

// Produtos: PROD-003 tem estoque 0 → gera erros 409 intencionais
const PRODUCTS = [
  { id: 'PROD-001', weight: 60 },  // 60% das requisições — sucesso
  { id: 'PROD-002', weight: 25 },  // 25% — sucesso (estoque baixo, esgota rápido)
  { id: 'PROD-003', weight: 15 },  // 15% — erro 409 intencional (estoque zero)
];

const USERS = ['user-alice', 'user-bob', 'user-carol', 'user-dave', 'user-eve',
               'user-frank', 'user-grace', 'user-heidi', 'user-ivan', 'user-judy'];

// ── Fases de carga ────────────────────────────────────────────────────────────
// Cada fase define: duração (s), rps mínimo, rps máximo, curva ('sine'|'ramp'|'flat')
const PHASES = [
  { name: 'warm-up',    duration: 30,  rpsMin: 0.5, rpsMax: 2,   curve: 'ramp'  },
  { name: 'normal',     duration: 60,  rpsMin: 2,   rpsMax: 4,   curve: 'sine'  },
  { name: 'peak',       duration: 45,  rpsMin: 6,   rpsMax: 10,  curve: 'ramp'  },
  { name: 'stress',     duration: 30,  rpsMin: 10,  rpsMax: 14,  curve: 'flat'  },
  { name: 'recovery',   duration: 45,  rpsMin: 10,  rpsMax: 1,   curve: 'ramp'  },
  { name: 'valley',     duration: 30,  rpsMin: 0.3, rpsMax: 1,   curve: 'sine'  },
  { name: 'spike',      duration: 20,  rpsMin: 15,  rpsMax: 20,  curve: 'flat'  },
  { name: 'cool-down',  duration: 40,  rpsMin: 5,   rpsMax: 0.5, curve: 'ramp'  },
];

// ── Utilitários ───────────────────────────────────────────────────────────────

function pick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.id;
  }
  return items[0].id;
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function currentRps(phase, elapsed) {
  const t = elapsed / phase.duration; // 0..1
  switch (phase.curve) {
    case 'ramp': return phase.rpsMin + (phase.rpsMax - phase.rpsMin) * t;
    case 'sine': return phase.rpsMin + (phase.rpsMax - phase.rpsMin) * (0.5 + 0.5 * Math.sin(t * Math.PI * 4));
    case 'flat': return rand(phase.rpsMin * 0.9, phase.rpsMax * 1.1);
    default:     return phase.rpsMin;
  }
}

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'load-bot',
    message: msg,
    ...extra,
  }));
}

// ── Requisição ────────────────────────────────────────────────────────────────

async function sendOrder(phase) {
  const productId = pick(PRODUCTS);
  const userId    = USERS[Math.floor(Math.random() * USERS.length)];
  const quantity  = Math.random() < 0.8 ? 1 : 2;
  const start     = Date.now();

  try {
    const res = await axios.post(`${BASE_URL}/orders`, { userId, productId, quantity }, { timeout: 5000 });
    const ms  = Date.now() - start;
    log('info', 'order.success', {
      phase: phase.name, productId, userId, quantity,
      orderId: res.data.orderId, traceId: res.data.traceId,
      statusCode: 201, durationMs: ms,
    });
  } catch (err) {
    const ms         = Date.now() - start;
    const statusCode = err.response?.status || 0;
    const errorType  = statusCode === 409 ? 'stock_insufficient'
                     : statusCode === 400 ? 'bad_request'
                     : statusCode >= 500  ? 'server_error'
                     : 'network_error';
    log('error', 'order.failed', {
      phase: phase.name, productId, userId, quantity,
      statusCode, errorType, durationMs: ms,
      error: err.response?.data?.error || err.message,
    });
  }
}

// ── Loop principal ────────────────────────────────────────────────────────────

async function runPhase(phase) {
  log('info', 'phase.start', { phase: phase.name, duration: phase.duration, rpsMin: phase.rpsMin, rpsMax: phase.rpsMax });

  const phaseEnd = Date.now() + phase.duration * 1000;
  let   tick     = Date.now();

  while (Date.now() < phaseEnd) {
    const elapsed = (phase.duration * 1000 - (phaseEnd - Date.now())) / 1000;
    const rps     = currentRps(phase, elapsed);
    const delay   = Math.max(50, 1000 / rps); // mínimo 50ms entre requests

    await sendOrder(phase);

    const spent = Date.now() - tick;
    const wait  = Math.max(0, delay - spent);
    await new Promise(r => setTimeout(r, wait));
    tick = Date.now();
  }

  log('info', 'phase.end', { phase: phase.name });
}

async function main() {
  log('info', 'bot.start', { phases: PHASES.map(p => p.name), targetUrl: BASE_URL });

  // Aguarda api-gateway estar pronto
  for (let i = 0; i < 20; i++) {
    try {
      await axios.get(`${BASE_URL}/health`, { timeout: 2000 });
      log('info', 'bot.ready', { message: 'api-gateway respondendo, iniciando carga' });
      break;
    } catch {
      log('info', 'bot.waiting', { attempt: i + 1, message: 'aguardando api-gateway...' });
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Executa fases em loop contínuo
  while (true) {
    for (const phase of PHASES) {
      await runPhase(phase);
    }
    log('info', 'bot.cycle', { message: 'ciclo completo, reiniciando...' });
  }
}

main().catch(err => {
  log('error', 'bot.fatal', { error: err.message });
  process.exit(1);
});
