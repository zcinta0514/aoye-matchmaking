#!/usr/bin/env python3
"""常驻转写进程：模型只加载一次，然后连续处理音频文件列表。

用法:
  python3 transcribe_batch.py --list <file.list> [--shard i/n] [--prompt-file p.txt]

每个输入行：<wav绝对路径>\t<输出目录>\t<basename>
"""
import argparse
import os
import sys
import time
import traceback

os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

DEFAULT_PROMPT = (
    "以下是婚恋择偶定位访谈的普通话内容，说话人常与相亲者对话。"
    "常见术语：颜值分、5分、5.5分、6分、班草、校草、保底、择偶定位、天花板、兜底、"
    "硬件、软件、情绪价值、门当户对、高净值、性价比、脱单、相亲、月老鳌烨、"
    "身高、体重、学历、工作、房子、车子、年薪、户籍、体制内、编制、长相、气质、"
    "第一梯队、上嫁、下娶、向下兼容、原生家庭、独生女、独生子、婚恋画像、心智首选。"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True)
    ap.add_argument("--shard", default="0/1")
    ap.add_argument("--model", default="mlx-community/whisper-large-v3-turbo")
    ap.add_argument("--prompt-file", default=None)
    ap.add_argument("--resume-file", default=None, help="已完成的 basename 列表，用于断点续跑")
    args = ap.parse_args()

    prompt = DEFAULT_PROMPT
    if args.prompt_file and os.path.exists(args.prompt_file):
        prompt = open(args.prompt_file, encoding="utf-8").read().strip()

    done = set()
    if args.resume_file and os.path.exists(args.resume_file):
        done = {l.strip() for l in open(args.resume_file, encoding="utf-8") if l.strip()}

    with open(args.list, encoding="utf-8") as f:
        rows = [l.rstrip("\n").split("\t") for l in f if l.strip()]

    si, sn = (int(x) for x in args.shard.split("/"))
    rows = [r for i, r in enumerate(rows) if i % sn == si]
    rows = [r for r in rows if len(r) >= 3 and r[2] not in done]
    if not rows:
        print(f"[shard {args.shard}] 无待处理任务", flush=True)
        return

    # 延迟导入：模型只在真正有活时加载
    import mlx_whisper

    print(f"[shard {args.shard}] 开始，共 {len(rows)} 条", flush=True)
    t0 = time.time()
    audio_sec = 0.0
    ok = 0
    fail = 0
    for idx, (wav, outdir, base) in enumerate(rows):
        if not os.path.exists(wav):
            fail += 1
            continue
        os.makedirs(outdir, exist_ok=True)
        try:
            r = mlx_whisper.transcribe(
                wav,
                path_or_hf_repo=args.model,
                language="zh",
                initial_prompt=prompt,
                verbose=None,
                condition_on_previous_text=False,  # 抑制“拜拜/谢谢”类重复幻觉
                compression_ratio_threshold=2.6,
                no_speech_threshold=0.65,
            )
            segs = r.get("segments", [])
            lines = [s.get("text", "").strip() for s in segs]
            text = "\n".join(l for l in lines if l)
            with open(os.path.join(outdir, base + ".txt"), "w", encoding="utf-8") as f:
                f.write(text)

            def ts(sec):
                ms = int(round(sec * 1000))
                h, ms = divmod(ms, 3600000)
                m, ms = divmod(ms, 60000)
                s, ms = divmod(ms, 1000)
                return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

            with open(os.path.join(outdir, base + ".srt"), "w", encoding="utf-8") as f:
                for n, s in enumerate(segs, 1):
                    f.write(f"{n}\n{ts(s['start'])} --> {ts(s['end'])}\n{s.get('text','').strip()}\n\n")
            ok += 1
            audio_sec += segs[-1]["end"] if segs else 0
        except Exception as e:
            fail += 1
            print(f"  ! {base} {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            traceback.print_exc(limit=1)
        if idx % 20 == 19 or idx == len(rows) - 1:
            el = time.time() - t0
            print(
                f"[shard {args.shard}] {idx+1}/{len(rows)} ok={ok} fail={fail} "
                f"audio={audio_sec/60:.1f}min wall={el/60:.1f}min rate={audio_sec/el if el else 0:.1f}x",
                flush=True,
            )


if __name__ == "__main__":
    main()
