// 在抖音用户主页内运行的采集函数（作为 browser act:evaluate 的 fn 源码使用）。
// 作用：挂载 XHR 钩子 -> 滚动到底 -> 把作品列表 POST 给本地 collector -> 返回统计。
// 返回体极小，避免把大 JSON 灌进 Agent 上下文。
async () => {
  const SEC = location.pathname.split('/user/')[1] || 'unknown';
  const PORT = 8799;
  const MAX_ROUNDS = window.__MAXROUNDS || 120;

  // 1) 钩住 XHR，收集 /aweme/v1/web/aweme/post/ 的响应
  if (!window.__h) {
    window.__h = { items: new Map(), last: null, err: null };
    const OX = window.XMLHttpRequest;
    const oOpen = OX.prototype.open;
    const oSend = OX.prototype.send;
    OX.prototype.open = function (m, u, ...r) { this.__u = u; return oOpen.call(this, m, u, ...r); };
    OX.prototype.send = function (...a) {
      this.addEventListener('load', () => {
        try {
          const u = String(this.__u || '');
          if (!u.includes('/aweme/v1/web/aweme/post/')) return;
          const d = JSON.parse(this.responseText);
          for (const x of (d.aweme_list || [])) window.__h.items.set(x.aweme_id, x);
          window.__h.last = { n: (d.aweme_list || []).length, hasMore: d.has_more, total: window.__h.items.size };
        } catch (e) { window.__h.err = String(e); }
      });
      return oSend.apply(this, a);
    };
  }

  // 2) 找到滚动容器并往下滚（抖音用内层滚动容器，不是 document scroll）
  const sc = () => document.querySelector('.route-scroll-container') || document.scrollingElement;
  let idle = 0;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const before = window.__h.items.size;
    const c = sc();
    c.scrollTop = c.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, window.__SCROLLWAIT || 700));
    if (window.__h.items.size === before) { idle++; if (idle >= 4) break; } else { idle = 0; }
    if (window.__h.last && window.__h.last.hasMore === 0) break;
  }

  // 3) 精简字段并落盘
  const items = Array.from(window.__h.items.values()).map((x) => ({
    aweme_id: x.aweme_id,
    desc: x.desc,
    create_time: x.create_time,
    digg: x.statistics && x.statistics.digg_count,
    comment: x.statistics && x.statistics.comment_count,
    share: x.statistics && x.statistics.share_count,
    duration: x.video && x.video.duration,
    play_url: x.video && x.video.play_addr && x.video.play_addr.url_list && x.video.play_addr.url_list[0],
    cover: x.video && x.video.cover && x.video.cover.url_list && x.video.cover.url_list[0],
    nickname: x.author && x.author.nickname,
    unique_id: x.author && x.author.unique_id,
    sec_uid: x.author && x.author.sec_uid,
    mix: x.mix_info ? x.mix_info.mix_name : null,
  }));

  const uid = (items[0] && items[0].unique_id) || SEC.slice(-12);
  const name = 'acc_' + uid + '.json';
  let resp = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/meta/aweme_raw/${name}`, {
      method: 'POST', body: JSON.stringify({ sec_uid: SEC, unique_id: uid, nickname: items[0] && items[0].nickname, count: items.length, hasMore: window.__h.last ? window.__h.last.hasMore : null, items }),
    });
    resp = await r.text();
  } catch (e) { resp = 'POST_ERR:' + String(e); }

  return { sec_uid: SEC, uid, count: items.length, hasMore: window.__h.last ? window.__h.last.hasMore : null, err: window.__h.err, resp: String(resp).slice(0, 200) };
}
