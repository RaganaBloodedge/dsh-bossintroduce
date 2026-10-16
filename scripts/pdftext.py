#!/usr/bin/env python3
"""PDF -> 文本 执行器。

用法:
  python pdftext.py <pdf> [--out <txt>] [--max-chars N] [--full]

输出协议（遵循 lmmarr-throttle references/protocol.md）:
  成功: OK / KEY... / DETAIL... 常量行，正文另附
  失败: FAIL / FIX / 原始异常整段
退出码: 0 成功 / 1 用法错 / 2 提取失败 / 3 无文本层（疑似扫描件）

为什么固化: 建能力图谱要读简历 PDF、后续解析 JD 也要读 PDF/文本，
同一操作在本项目内必然重复 —— 按纪律第二次就该由预置取代。
"""

import argparse
import sys
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    print("FAIL 缺少 pypdf")
    print("FIX  python -m pip install pypdf")
    sys.exit(2)

MAX_PRINT = 6000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default=None, help="把全文写到该路径（UTF-8）")
    ap.add_argument("--max-chars", type=int, default=MAX_PRINT)
    ap.add_argument("--full", action="store_true", help="打印全文，不截断")
    args = ap.parse_args()

    src = Path(args.pdf)
    if not src.is_file():
        print(f"FAIL 文件不存在: {src}")
        print("FIX  确认路径；中文路径要用引号包起来")
        return 1

    try:
        reader = PdfReader(str(src))
        pages = [p.extract_text() or "" for p in reader.pages]
    except Exception as exc:  # noqa: BLE001
        print("FAIL PDF 解析异常")
        print("FIX  若为加密件先解密；若为扫描件需走 OCR")
        print(f"RAW  {type(exc).__name__}: {exc}")
        return 2

    text = "\n\n".join(pages).strip()
    n_pages = len(pages)
    n_chars = len(text)

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")

    if n_chars == 0:
        # ⚠️ 不能打 "OK" 再返回 3：本项目的协议是 OK ⇒ 退出码 0。
        #    打 OK + 退出码 3 会让调用方（或人）误判成功（已实测这个不一致）。
        print("FAIL 解析成功但**没有文本层**")
        print(f"KEY  pages={n_pages} chars=0")
        print("DETAIL 疑似扫描件 —— 需 OCR（pytesseract + pdf2image），或改用带文本层的导出")
        print("FIX  换一份带文本层的 PDF，或先对扫描件做 OCR")
        return 3

    print("OK   提取完成")
    print(f"KEY  pages={n_pages} chars={n_chars}" + (f" out={args.out}" if args.out else ""))
    print(f"DETAIL src={src.name}")

    if args.full or n_chars <= args.max_chars:
        print("\n----- TEXT -----")
        print(text)
    else:
        print(f"\n----- TEXT (前 {args.max_chars} 字符，共 {n_chars}) -----")
        print(text[: args.max_chars])
        print(f"\n[已截断 {n_chars - args.max_chars} 字符；完整版见 --out 落盘文件]")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main())
