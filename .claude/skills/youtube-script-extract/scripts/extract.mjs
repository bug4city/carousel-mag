#!/usr/bin/env node
// 유튜브 링크 → 제목/설명 + 자막 전문을 정리된 마크다운으로 출력.
// 사용: node extract.mjs <유튜브URL> [출력파일.md]
//  - 출력파일 생략 시 stdout에 마크다운 출력.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.argv[2];
const outFile = process.argv[3];
if (!url || !/youtube\.com|youtu\.be/.test(url)) {
  console.error('사용법: node extract.mjs <유튜브URL> [출력파일.md]');
  process.exit(2);
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return decodeHtml(match[1]);
  }
  return '';
}

function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].trim()) : '';
}

function extractYouTubeDescription(html) {
  const match = (html || '').match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`).slice(0, 3000);
  } catch (error) {
    return '';
  }
}

async function fetchHtml(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });
  return res.text();
}

// 1순위: 브라우저 방식(yt-transcript.mjs — 유튜브 자체 '스크립트 패널'을 DOM에서 읽음,
//        확장프로그램과 같은 원리라 IP 레이트리밋(429)에 면역)
function fetchViaBrowser(targetUrl) {
  const script = path.join(__dirname, 'yt-transcript.mjs');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, targetUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SUDO_ASKPASS: '', SSH_ASKPASS: '', DISPLAY: '' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 75000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (err.trim()) console.error(`[browser] ${err.trim()}`);
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(out);
        resolve(data && data.text ? data : null);
      } catch (error) {
        resolve(null);
      }
    });
  });
}

// 2순위: yt-dlp, 언어별 순차(ko → ko-en → en). 전부 실패하면 null(설명란만) — 성공 위장 금지.
function findYtdlp() {
  const candidates = [process.env.YTDLP_PATH, '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp'].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execSync('which yt-dlp').toString().trim() || null;
  } catch (error) {
    return null;
  }
}

async function fetchViaYtdlp(targetUrl) {
  const ytdlp = findYtdlp();
  if (!ytdlp) return null;
  const LANGS = [['ko', 'ko'], ['ko-en', '영어→한국어 자동번역'], ['en', 'en']];
  for (const [code, label] of LANGS) {
    const tmpBase = path.join('/tmp', `ytscript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await new Promise((resolve) => {
      const child = spawn(ytdlp, [
        '--skip-download', '--write-subs', '--write-auto-subs',
        '--sub-langs', code, '--sub-format', 'json3',
        '--extractor-args', 'youtube:player_client=android',
        '--no-warnings', '-o', tmpBase, targetUrl,
      ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SUDO_ASKPASS: '', SSH_ASKPASS: '' } });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 45000);
      child.on('error', () => { clearTimeout(timer); resolve(); });
      child.on('close', () => { clearTimeout(timer); resolve(); });
    });
    try {
      const dir = path.dirname(tmpBase);
      const prefix = path.basename(tmpBase);
      const files = (await fsp.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json3'));
      if (!files.length) continue;
      const data = JSON.parse(await fsp.readFile(path.join(dir, files[0]), 'utf8'));
      await Promise.all(files.map((f) => fsp.unlink(path.join(dir, f)).catch(() => {})));
      const text = (data.events || [])
        .filter((ev) => ev.segs)
        .map((ev) => ev.segs.map((s) => s.utf8 || '').join(''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12000);
      if (text) return { text, lang: label };
    } catch (error) {
      /* 다음 언어 시도 */
    }
  }
  return null;
}

async function main() {
  const html = await fetchHtml(url);
  const title = extractMeta(html, 'og:title') || extractTitleTag(html) || '';
  const shortDesc = extractYouTubeDescription(html);
  const ogDescription = extractMeta(html, 'og:description') || '';
  const description = shortDesc || ogDescription || title;

  let transcript = await fetchViaBrowser(url);
  if (!transcript) transcript = await fetchViaYtdlp(url);

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`원본: ${url}`);
  lines.push('');
  lines.push('## 설명');
  lines.push(description);
  lines.push('');
  if (transcript) {
    lines.push(`## 스크립트 (${transcript.lang}, ${transcript.text.length}자)`);
    lines.push(transcript.text);
  } else {
    lines.push('## 스크립트');
    lines.push('(자막 추출 실패 — 이 영상엔 자막이 없거나 두 방식 모두 실패했습니다)');
  }
  const markdown = lines.join('\n');

  if (outFile) {
    await fsp.writeFile(outFile, markdown, 'utf8');
    console.error(`저장됨: ${outFile}`);
  } else {
    process.stdout.write(markdown + '\n');
  }
}

main();
