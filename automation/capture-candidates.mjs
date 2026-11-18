import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';

const root = process.cwd();
const outputFile = path.join(root, 'auction-candidates.js');
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

function readExisting() {
  if (!fs.existsSync(outputFile)) return null;
  try {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(outputFile, 'utf8'), context, { timeout: 1000 });
    const value = context.window.AUCTION_SERVER_CANDIDATES;
    return value && Array.isArray(value.rows) ? value : null;
  } catch (_) {
    return null;
  }
}

async function waitForClose(day) {
  const p = chinaParts();
  if (['Sat', 'Sun'].includes(p.weekday)) {
    throw new Error(`今天 ${day} 是周末，不生成下一交易日候选`);
  }
  const seconds = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  if (seconds < 54060) {
    const waitMs = (54060 - seconds) * 1000 + 1500;
    console.log(`等待北京时间15:01:01，约 ${Math.ceil(waitMs / 1000)} 秒`);
    await sleep(waitMs);
  }
  const after = chinaParts();
  const afterSeconds = Number(after.hour) * 3600 + Number(after.minute) * 60 + Number(after.second);
  if (afterSeconds > 79200) throw new Error('已超过22:00，拒绝生成过期候选数据');
}

function serve() {
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
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
    server.listen(4174, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const day = chinaDay();
  const existing = readExisting();
  if (existing && String(existing.day) === day) {
    console.log(`云端已有 ${day} 候选评分，不重复生成`);
    return;
  }
  await waitForClose(day);
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({
      locale: 'zh-CN',
      timezoneId: timeZone,
      viewport: { width: 1280, height: 900 }
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto('http://127.0.0.1:4174/index.html?automation=1', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForFunction(
      () => window.AUCTION_CANDIDATES_SNAPSHOT && Array.isArray(window.AUCTION_CANDIDATES_SNAPSHOT.rows),
      null,
      { timeout: 15 * 60 * 1000, polling: 2500 }
    );
    const snapshot = await page.evaluate(() => window.AUCTION_CANDIDATES_SNAPSHOT);
    if (String(snapshot.day) !== day) {
      console.log(`今日 ${day} 暂无新涨停定稿，保留上一交易日候选`);
      return;
    }
    const payload = {
      ...snapshot,
      schema: 'auction-server-candidates-v1',
      generatedAt: new Date().toISOString(),
      sourceVersion: 'auction-v52-20261118-cloud-candidates'
    };
    fs.writeFileSync(
      outputFile,
      `window.AUCTION_SERVER_CANDIDATES = ${JSON.stringify(payload)};\n`,
      'utf8'
    );
    console.log(JSON.stringify({
      day,
      totalCount: payload.totalCount,
      rows: payload.rows.length,
      top: payload.rows.slice(0, 5).map((row) => `${row.name} ${row.nextDayScore}`),
      errors
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
