#!/usr/bin/env node
// 鳌烨语料采集流水线：作品元数据 -> 视频下载 -> 音频抽取 -> 语音转写
//
// 用法:
//   node tools/pipeline.mjs --account aoye98 [--limit 20] [--concurrency 4] [--stage all]
//
// 依赖: ffmpeg, /tmp/aoye_test/venv/bin/mlx_whisper (mlx-whisper + large-v3-turbo)
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'data');
const FFMPEG = `${process.env.HOME}/.local/bin/ffmpeg`;
const WHISPER = process.env.WHISPER_BIN || '/tmp/aoye_test/venv/bin/mlx_whisper';
const MODEL = process.env.WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo';

// 领域词表：显著提升婚恋/择偶术语的识别率
const INITIAL_PROMPT = process.env.WHISPER_PROMPT || [
  '以下是婚恋择偶定位访谈的普通话内容，说话人常与相亲者对话。',
  '常见术语：颜值分、5分、5.5分、6分、班草、校草、保底、择偶定位、天花板、兜底、',
  '硬件、软件、情绪价值、门当户对、高净值、性价比、脱单、相亲、月老鳌烨、',
  '身高、体重、学历、工作、房子、车子、年薪、户籍、体制内、编制、长相、气质、',
  '第一梯队、第二梯队、上嫁、下娶、向下兼容、原生家庭、独生女、独生子。',
].join('');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const ACCOUNT = arg('account');
const LIMIT = Number(arg('limit', 0)) || 0;
const CONCURRENCY = Number(arg('concurrency', 4));
const STAGE = arg('stage', 'all');
const OFFSET = Number(arg('offset', 0)) || 0;
const ONLY = arg('only', null); // 指定 aweme_id 逗号分隔

if (!ACCOUNT) {
  console.error('缺少 --account（对应 data/meta/aweme_raw/<account>.json）');
  process.exit(1);
}

const RAW = join(DATA, 'meta', 'manifests', `${ACCOUNT}.json`);
const VIDEO_DIR = join(DATA, 'video', ACCOUNT);
const AUDIO_DIR = join(DATA, 'audio', ACCOUNT);
const TEXT_DIR = join(DATA, 'transcripts', ACCOUNT);
const STATE = join(DATA, 'meta', 'state', `${ACCOUNT}.json`);
for (const d of [VIDEO_DIR, AUDIO_DIR, TEXT_DIR, dirname(STATE)]) mkdirSync(d, { recursive: true });

const items = JSON.parse(readFileSync(RAW, 'utf8'));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
let queue = items.filter((it) => {
  const s = state[it.aweme_id];
  return !s || !s.transcribed;
});
if (ONLY) {
  const ids = new Set(String(ONLY).split(','));
  queue = items.filter((it) => ids.has(it.aweme_id));
}
if (OFFSET) queue = queue.slice(OFFSET);
if (LIMIT) queue = queue.slice(0, LIMIT);

console.log(`[pipeline] account=${ACCOUNT} total=${items.length} todo=${queue.length} concurrency=${CONCURRENCY} stage=${STAGE}`);

async function download(it) {
  const mp4 = join(VIDEO_DIR, `${it.aweme_id}.mp4`);
  if (existsSync(mp4) && statSync(mp4).size > 50_000) return mp4;
  const url = it.play_url;
  if (!url) throw new Error('no play_url');
  const { stdout } = await pexec('curl', [
    '-sL', '--max-time', '180', '-H', 'Referer: https://www.douyin.com/',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-o', mp4, '-w', '%{http_code} %{size_download}', url,
  ], { maxBuffer: 1 << 20 });
  const [code, size] = stdout.trim().split(' ');
  if (code !== '200' || Number(size) < 50_000) {
    try { rmSync(mp4); } catch {}
    throw new Error(`download http=${code} size=${size}`);
  }
  return mp4;
}

async function toWav(mp4, awemeId) {
  const wav = join(AUDIO_DIR, `${awemeId}.wav`);
  if (existsSync(wav) && statSync(wav).size > 10_000) return wav;
  await pexec(FFMPEG, ['-y', '-loglevel', 'error', '-i', mp4, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { maxBuffer: 1 << 20 });
  return wav;
}

async function transcribe(wav, awemeId) {
  const outdir = join(AUDIO_DIR, '..', '..', 'tmp_whisper', ACCOUNT);
  mkdirSync(outdir, { recursive: true });
  await pexec(WHISPER, [
    wav, '--model', MODEL, '--language', 'zh',
    '--output-dir', outdir, '--output-format', 'all',
    '--initial-prompt', INITIAL_PROMPT,
  ], { maxBuffer: 1 << 24, env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  const txt = readFileSync(join(outdir, `${awemeId}.txt`), 'utf8').trim();
  writeFileSync(join(TEXT_DIR, `${awemeId}.txt`), txt);
  try { writeFileSync(join(TEXT_DIR, `${awemeId}.srt`), readFileSync(join(outdir, `${awemeId}.srt`))); } catch {}
  const lines = readFileSync(join(outdir, `${awemeId}.srt`), 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->'));
  return lines.length ? lines.join('\n') : txt;
}

async function handle(it) {
  const t0 = Date.now();
  const rec = state[it.aweme_id] || (state[it.aweme_id] = { aweme_id: it.aweme_id, desc: it.desc, create_time: it.create_time, digg: it.digg, duration: it.duration });
  try {
    if (STAGE === 'audio') {
      const mp4 = await download(it);
      await toWav(mp4, it.aweme_id);
      rec.audioReady = true;
      rec.ok = true;
    } else if (STAGE === 'download') { await download(it); }
    else if (STAGE === 'transcribe') {
      const mp4 = join(VIDEO_DIR, `${it.aweme_id}.mp4`);
      const wav = await toWav(mp4, it.aweme_id);
      rec.text = await transcribe(wav, it.aweme_id);
      rec.transcribed = true;
    } else {
      const mp4 = await download(it);
      const wav = await toWav(mp4, it.aweme_id);
      rec.text = await transcribe(wav, it.aweme_id);
      rec.transcribed = true;
      try { rmSync(wav); } catch {}
    }
    rec.ms = Date.now() - t0;
    rec.ok = true;
  } catch (e) {
    rec.ok = false;
    rec.error = String(e.message || e);
    console.error(`  ✗ ${it.aweme_id} ${rec.error}`);
  }
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  const done = Object.values(state).filter((x) => x.ok).length;
  const secs = Object.values(state).filter((x) => x.ok).reduce((a, b) => a + (b.duration || 0), 0) / 1000;
  process.stdout.write(`  ${rec.ok ? '✓' : '✗'} ${it.aweme_id} ${(rec.duration / 1000).toFixed(0)}s in ${(rec.ms / 1000).toFixed(1)}s | ok=${done} audio=${(secs / 60).toFixed(1)}min\n`);
}

async function main() {
  const t0 = Date.now();
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
    while (idx < queue.length) {
      const it = queue[idx++];
      await handle(it);
    }
  });
  await Promise.all(workers);
  const el = (Date.now() - t0) / 1000;
  const ok = Object.values(state).filter((x) => x.ok).length;
  const secs = Object.values(state).filter((x) => x.ok).reduce((a, b) => a + (b.duration || 0), 0) / 1000;
  console.log(`[pipeline] done ${ok} clips, ${(secs / 60).toFixed(1)} min audio in ${(el / 60).toFixed(1)} min wall (${(secs / el).toFixed(1)}x realtime)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
