// PLaMo 3 Translate を OpenAI 互換 API として起動する。
// 使い方: bun run serve [2b|8b|0.8b|31b]   (既定 2b、ポート 8000)
import { join } from "node:path";

const size = process.argv[2] || "2b";
const quant = process.env.QUANT || "Q4_K_M";
const port = process.env.PORT || "8000";
const repo = `pfnet/plamo-3-translate-${size}-GGUF`;
const dir = join(import.meta.dir, "models", `plamo-3-translate-${size}-GGUF`);
const ggufName = `plamo-3-translate-${size}-${quant}.gguf`;
const gguf = join(dir, ggufName);
const template = join(dir, "chat_template.jinja");

function requireCommand(command: string) {
  if (!Bun.which(command)) {
    console.error(`${command} is not on PATH. See the requirements in README.md.`);
    process.exit(1);
  }
}

requireCommand("llama-server");

if (!(await Bun.file(gguf).exists()) || !(await Bun.file(template).exists())) {
  requireCommand("uvx");
  const download = Bun.spawn([
    "uvx", "--from", "huggingface_hub", "hf", "download", repo, ggufName,
    "chat_template.jinja", "LICENSE/ja", "LICENSE/en", "--local-dir", dir,
  ], { stdio: ["inherit", "inherit", "inherit"] });
  const status = await download.exited;
  if (status !== 0) process.exit(status);
}

// POSIX: llama-server は 2 回目の SIGINT で即座に異常終了する。端末の Ctrl+C はプロセスグループ全員に届くので、
// 子を別セッションに分け、転送の 1 回だけが届くようにする。別セッションには端末の切断も届かないので SIGHUP も転送する。
// Windows: Ctrl+C はコンソールから子にも直接届き、kill は強制終了になる。detached にすると子の出力がコンソールに出ず、
// 親を強制終了したときに子が残る。どちらもしない。
const posix = process.platform !== "win32";

// GGUF に埋め込まれたテンプレートは古いので、同梱の chat_template.jinja を必ず使う（モデルカードの指示）。
// -c は 4 スロットで割られる。1 スロット 16384 トークンあれば、長い段落でも入力と訳の両方が収まる。
const server = Bun.spawn([
  "llama-server",
  "-m", gguf,
  "--chat-template-file", template,
  "--no-prefill-assistant",
  "--alias", "plamo-3-translate",
  "-c", "65536",
  "--parallel", "4",
  "--host", "127.0.0.1",
  "--port", port,
], { stdio: ["inherit", "inherit", "inherit"], detached: posix });
if (posix) {
  // bun run の中では、端末から届く分と bun run が転送する分で同じ Ctrl+C を 2 回受けることがある。
  // 人が押し直すより短い間隔の重複は 1 回として扱う。
  let lastForward = 0;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      const now = Date.now();
      if (now - lastForward < 100) return;
      lastForward = now;
      server.kill(signal);
    });
  }
}
process.exit(await server.exited);
