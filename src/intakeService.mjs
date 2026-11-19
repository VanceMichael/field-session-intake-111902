// 收件流程 HTTP 服务：老师按队次接收数据、补正归属、发放学校件、出场地缺报。
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createSourceClient } from './sourceClient.mjs';
import { VisitSession, loadSessions } from './session.mjs';

async function readJson(request) {
  let input = '';
  for await (const chunk of request) {
    input += chunk;
    if (input.length > 65536) {
      throw Object.assign(new Error('请求正文超出限制'), { status: 400 });
    }
  }
  if (!input) return {};
  try {
    return JSON.parse(input);
  } catch {
    throw Object.assign(new Error('请求正文应为 JSON'), { status: 400 });
  }
}

export async function createIntakeService({ origin, dataDir }) {
  const client = createSourceClient(origin);
  const sessions = await loadSessions(dataDir, client);

  return createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 0 && request.method === 'GET') {
        return send(200, { name: '研学现场资料收件流程', visits: [...sessions.keys()] });
      }
      if (parts[0] !== 'visits') return send(404, { error: '查无路径' });
      if (request.method === 'POST' && parts.length === 1) {
        const body = await readJson(request);
        if (body && typeof body.visit === 'string' && sessions.has(body.visit)) {
          return send(409, { error: '队次已存在 ' + body.visit });
        }
        const name = typeof body?.visit === 'string' && body.visit ? body.visit : '未命名';
        const session = await VisitSession.create({ dir: join(dataDir, name), client, request: body });
        sessions.set(session.id, session);
        return send(201, session.summary());
      }
      const session = sessions.get(parts[1]);
      if (!session) return send(404, { error: '查无队次 ' + (parts[1] ?? '') });
      const action = parts[2] ?? '';
      if (request.method === 'GET' && action === '') return send(200, session.summary());
      if (request.method === 'POST' && action === 'sync') {
        const body = await readJson(request);
        return send(200, await session.sync({ purpose: body.purpose }));
      }
      if (request.method === 'POST' && action === 'resolve') {
        const body = await readJson(request);
        if (!body.observation || !body.group) return send(400, { error: '裁定需带 observation 与 group' });
        return send(200, await session.resolve(body.observation, body.group, body.note));
      }
      if (request.method === 'POST' && action === 'issue-replacement') {
        const body = await readJson(request);
        if (!body.stamp || !body.group) return send(400, { error: '补做样本发放需带 stamp 与 group' });
        return send(200, await session.issueReplacement(body.stamp, body.group));
      }
      if (request.method === 'GET' && action === 'ledger') {
        return send(200, { visit: session.id, boots: session.ledger() });
      }
      if (request.method === 'GET' && action === 'observations') {
        return send(200, {
          visit: session.id,
          observations: Object.values(session.state.observations).map(obs => session.observationView(obs)),
        });
      }
      if (request.method === 'GET' && action === 'venue-report') return send(200, session.venueReport());
      if (request.method === 'GET' && action === 'pickups') {
        return send(200, {
          visit: session.id,
          pickups: session.state.pickups,
          withdrawals: session.state.withdrawals,
          notifications: session.state.notifications,
        });
      }
      return send(404, { error: '查无路径' });
    } catch (error) {
      return send(error.status ?? 500, {
        error: error.message,
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
      });
    }
  });
}
