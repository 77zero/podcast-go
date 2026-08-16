#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
faster-whisper 转写工作脚本。
被 Electron 主进程以子进程方式调用，通过 stdout 流式输出：
  STATUS <阶段>
  DURATION <秒>
  SEG <start>\t<end>\t<text>          （每段一行，实时）
  RESULT <json>                        （最终结果，一行）
  ERROR <message>                      （出错时）
支持 cuda / cpu 自动选择；模型下载失败时自动切换 HF 镜像重试；
GPU 运行库缺失（cublas/cudnn 等 DLL 找不到）时自动降级为 CPU 转写，保证功能可用。
"""
import argparse
import json
import os
import sys
import traceback


def log(line):
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def emit(key, value):
    log("{}\t{}".format(key, value))


def get_duration(path):
    try:
        import av
        with av.open(path) as c:
            d = float(c.duration) / 1_000_000.0  # µs -> s
            return d if d > 0 else None
    except Exception:
        return None


def is_cuda_lib_error(msg):
    """GPU 运行库缺失/无法加载的典型错误，这类错误值得降级到 CPU 重试。"""
    m = (msg or "").lower()
    return any(k in m for k in (
        "not found", "cannot be loaded", "could not load",
        ".dll", "cublas", "cudnn", "ctranslate2",
        "cuda driver", "cuda error", "invalid device function",
        "no kernel image",
    ))


def try_load_model(model_size, device, compute_type, hf_endpoint=None):
    if hf_endpoint:
        os.environ["HF_ENDPOINT"] = hf_endpoint
        os.environ.setdefault("HUGGINGFACE_HUB_ENDPOINT", hf_endpoint)
    from faster_whisper import WhisperModel
    emit("STATUS", "loading_model")
    return WhisperModel(model_size, device=device, compute_type=compute_type)


def load_model(model_size, device, compute_type):
    """加载模型；模型下载失败（非 CUDA 库问题）时切 HF 镜像重试一次。"""
    try:
        return try_load_model(model_size, device, compute_type)
    except Exception as e:
        if is_cuda_lib_error(str(e)):
            raise  # GPU 库缺失，交给上层降级到 CPU
        if not os.environ.get("HF_ENDPOINT"):
            try:
                emit("STATUS", "retry_mirror")
                return try_load_model(model_size, device, compute_type, hf_endpoint="https://hf-mirror.com")
            except Exception:
                pass
        raise


def transcribe(model, input_path, lang, beam):
    """执行转写并逐段输出，返回 (segments, info)。
    VAD 不可用（缺 onnxruntime 等）时自动退化为无 VAD 转写，保证功能可用。"""
    emit("STATUS", "decoding")
    try:
        segments_iter, info = model.transcribe(
            input_path,
            language=lang,
            vad_filter=True,
            beam_size=beam,
            condition_on_previous_text=True,
        )
    except Exception as e:
        msg = str(e).lower()
        if "onnxruntime" in msg or "vad" in msg:
            emit("STATUS", "vad_fallback")
            segments_iter, info = model.transcribe(
                input_path,
                language=lang,
                vad_filter=False,
                beam_size=beam,
                condition_on_previous_text=True,
            )
        else:
            raise
    segments = []
    for seg in segments_iter:
        s = {
            "start": round(float(seg.start), 2),
            "end": round(float(seg.end), 2),
            "text": (seg.text or "").strip(),
        }
        segments.append(s)
        emit("SEG", "{}\t{}\t{}".format(s["start"], s["end"], s["text"]))
    return segments, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)          # <base>.json
    ap.add_argument("--model", default="small")
    ap.add_argument("--device", default="auto")          # auto|cuda|cpu
    ap.add_argument("--language", default="auto")        # auto|zh|en|...
    ap.add_argument("--beam", type=int, default=5)
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        emit("ERROR", "找不到音频文件：{}".format(args.input))
        return 2

    # 设备选择
    device = args.device
    compute_type = "int8"
    if device == "auto":
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
                compute_type = "float16"
            else:
                device = "cpu"
        except Exception:
            device = "cpu"
    elif device == "cuda":
        compute_type = "float16"

    # 转写计划：GPU 优先；GPU 运行库缺失时降级 CPU 重试一次
    attempts = [(device, compute_type)]
    if device == "cuda":
        attempts.append(("cpu", "int8"))

    lang = None if args.language in ("auto", "none") else args.language
    duration = None
    segments = None
    info = None
    gpu_fallback = False
    last_err = None

    for (dev, ct) in attempts:
        if dev == "cpu" and len(attempts) > 1:
            emit("STATUS", "cpu_fallback")
            gpu_fallback = True
        try:
            model = load_model(args.model, dev, ct)
            duration = get_duration(args.input)
            if duration:
                emit("DURATION", "{}".format(duration))
            segments, info = transcribe(model, args.input, lang, args.beam)
            device, compute_type = dev, ct
            break
        except Exception as e:
            last_err = e
            # 只有「GPU 库缺失」错误才值得降到 CPU 重试；其余直接报错
            if not (dev == "cuda" and is_cuda_lib_error(str(e))):
                break

    if segments is None:
        emit("ERROR", "转写失败：{}".format(last_err))
        return 4

    result = {
        "ok": True,
        "model": args.model,
        "device_used": device,
        "compute_type": compute_type,
        "language": getattr(info, "language", None) if info else None,
        "duration": duration,
        "gpu_fallback": gpu_fallback,
        "segments": segments,
    }

    base = os.path.splitext(args.output)[0]
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    # 生成带时间轴的 .txt
    try:
        with open(base + ".txt", "w", encoding="utf-8") as f:
            f.write("模型: {} · 设备: {} · 语言: {}\n".format(result["model"], device, result["language"]))
            f.write("时长: {:.1f} 秒 · 分段: {}\n\n".format(duration or 0, len(segments)))
            for s in segments:
                f.write("[{:02d}:{:02d}] {}\n".format(int(s["start"]) // 60, int(s["start"]) % 60, s["text"]))
    except Exception:
        pass

    emit("RESULT", json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        emit("ERROR", traceback.format_exc())
        sys.exit(1)
