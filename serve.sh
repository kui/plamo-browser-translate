#!/usr/bin/env bash
# PLaMo 3 Translate を OpenAI 互換 API として起動する。
# 使い方: ./serve.sh [2b|8b|0.8b|31b]   (既定 2b、ポート 8000)
set -euo pipefail

size="${1:-2b}"
quant="${QUANT:-Q4_K_M}"
port="${PORT:-8000}"
repo="pfnet/plamo-3-translate-${size}-GGUF"
dir="$(cd "$(dirname "$0")" && pwd)/models/plamo-3-translate-${size}-GGUF"
gguf="plamo-3-translate-${size}-${quant}.gguf"

if [[ ! -f "$dir/$gguf" || ! -f "$dir/chat_template.jinja" ]]; then
  uvx --from huggingface_hub hf download "$repo" "$gguf" chat_template.jinja LICENSE/ja LICENSE/en --local-dir "$dir"
fi

# GGUF に埋め込まれたテンプレートは古いので、同梱の chat_template.jinja を必ず使う（モデルカードの指示）。
# -c は 4 スロットで割られる。1 スロット 16384 トークンあれば、長い段落でも入力と訳の両方が収まる。
exec llama-server \
  -m "$dir/$gguf" \
  --chat-template-file "$dir/chat_template.jinja" \
  --no-prefill-assistant \
  --alias plamo-3-translate \
  -c 65536 \
  --parallel 4 \
  --host 127.0.0.1 \
  --port "$port"
