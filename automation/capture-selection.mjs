import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';

const root = process.cwd();
const lockKey = 'auction_lite_lock_v2';
const outputFile = path.join(root, 'auction-current.js');
const timeZone = 'Asia/Shanghai';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chinaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map((item) => [item.type, item.value]));
}

function chinaDay() {
  const p = chinaParts();
  return `${p.year}${p.month}${p.day}`;
}

function readCurrentSelection() {
  if (!fs.existsSync(outputFile)) return null;
  try {
    const code = fs.readFileSync(outputFile, 'utf8');
    const context = { window: {} };
    vm.runInNewContext(code, context, { timeout: 1000 });
    const value = context.window.AUCTION_SERVER_SELECTION;
    return value && value.data && Array.isArray(value.data.picks) ? value : null;
  } catch (_) {
    return null;
  }
}

async function waitForAuctionWindow(day) {
  const p = chinaParts();
  if (['Sat', 'Sun'].includes(p.weekday)) {
    throw new Error(`今天 ${day} 是周末，不执行竞价选股`);
  }
  const seconds = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  if (seconds < 33903) {
    const waitMs = (33903 - seconds) * 1000 + 1200;
    console.log(`等待北京时间09:25:03，约 ${Math.ceil(waitMs / 1000)} 秒`);
    await sleep(waitMs);
  }
  const after = chinaParts();
  const afterSeconds = Number(after.hour) * 3600 + Number(after.minute) * 60 + Number(after.second);
  if (afterSeconds > 36000) {
    throw new Error('已超过10:00，拒绝使用盘中后续盘口冒充09:25定稿');
  }
}

function serve() {
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8'
  };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    fs.readFile(file, (error, body) => {
      if (error) {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      response.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4173, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const day = chinaDay();
  const existing = readCurrentSelection();
  if (existing && String(existing.day) === day) {
    console.log(`云端已有 ${day} 定稿，不重复生成`);
    return;
  }

  await waitForAuctionWindow(day);
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({
      locale: 'zh-CN',
      timezoneId: timeZone,
      viewport: { width: 1280, height: 800 }
    });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto('http://127.0.0.1:4173/index.html?automation=1', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForFunction(
      ({ key, expectedDay }) => {
        try {
          const record = JSON.parse(localStorage.getItem(key) || 'null');
          return record?.day === expectedDay && record?.data && Array.isArray(record.data.picks);
        } catch (_) {
          return false;
        }
      },
      { key: lockKey, expectedDay: day },
      { timeout: 12 * 60 * 1000, polling: 2000 }
    );
    const lock = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), lockKey);
    if (String(lock?.data?.day || '') !== day) {
      throw new Error(`选股数据日 ${lock?.data?.day || '--'} 与今天 ${day} 不一致，可能是休市`);
    }
    const generatedAt = new Date().toISOString();
    const payload = {
      schema: 'auction-server-selection-v1',
      generatedAt,
      day,
      sourceVersion: lock.version || '',
      data: {
        ...lock.data,
        selectionSource: 'server-canonical',
        serverGeneratedAt: generatedAt
      }
    };
    fs.writeFileSync(
      outputFile,
      `window.AUCTION_SERVER_SELECTION = ${JSON.stringify(payload)};\n`,
      'utf8'
    );
    console.log(JSON.stringify({
      day,
      picks: payload.data.picks.map((pick) => `${pick.name} ${pick.code}`),
      lockedAt: payload.data.lockedAt,
      pageErrors
    }));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
