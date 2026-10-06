#!/usr/bin/env node
// 把 data/meta/aweme_raw/acc2_*.json 合并成 data/meta/manifests/<account>.json（按 aweme_id 去重）
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RAW = join(ROOT, 'data', 'meta', 'aweme_raw');
const OUT = join(ROOT, 'data', 'meta', 'manifests');
mkdirSync(OUT, { recursive: true });

const seen = new Set();
const index = [];
for (const f of readdirSync(RAW).filter((x) => x.startsWith('acc2_') && x.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(join(RAW, f), 'utf8'));
  const acct = d.account || {};
  const uid = acct.unique_id || f.replace(/^acc2_|\.json$/g, '');
  const rows = [];
  for (const it of d.items || []) {
    if (!it.play_url) continue;
    rows.push({
      aweme_id: it.aweme_id,
      desc: it.desc,
      create_time: it.create_time,
      digg: it.digg,
      comment: it.comment,
      share: it.share,
      duration: it.duration,
      play_url: it.play_url,
      cover: it.cover,
      // 作者（权威归属）与列表所属账号可能不同：抖音共创视频会同时出现在多个账号的作品页。
      // 证据校验以 author 为准，列表所属账号仅作索引。
      author: it.nickname || null,
      ownerAccount: uid,
      likes: it.digg,
    });
  }
  rows.sort((a, b) => b.create_time - a.create_time);
  writeFileSync(join(OUT, `${uid}.json`), JSON.stringify(rows, null, 1));
  index.push({ account: uid, nickname: acct.nickname, follower: acct.follower, count: rows.length, minutes: Math.round(rows.reduce((a, b) => a + (b.duration || 0), 0) / 60000) });
  for (const r of rows) seen.add(r.aweme_id);
}
index.sort((a, b) => b.count - a.count);
writeFileSync(join(ROOT, 'data', 'meta', 'manifests', '_index.json'), JSON.stringify({ accounts: index.length, totalUnique: seen.size, list: index }, null, 2));
console.log('manifests:', index.length, 'accounts,', seen.size, 'unique aweme_ids');
