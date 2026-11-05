// PLaMo 3 Translate を OpenAI 互換 API として起動する。
// 使い方: bun run serve [2b|8b|0.8b|31b]   (既定 2b、ポート 8000)
import { homedir } from "node:os";
import { join } from "node:path";

const size = process.argv[2] || "2b";
const quant = process.env.QUANT || "Q4_K_M";
const port = process.env.PORT || "8000";
const repo = `pfnet/plamo-3-translate-${size}-GGUF`;
// リポジトリの中に置くと、git worktree ごとに同じモデルを取得し直し、作業後も大きなファイルが残る。
const modelsDir = process.env.MODELS_DIR || join(homedir(), ".cache", "plamo-browser-translate", "models");
const dir = join(modelsDir, `plamo-3-translate-${size}-GGUF`);
const ggufName = `plamo-3-translate-${size}-${quant}.gguf`;
const gguf = join(dir, ggufName);
const template = join(dir, "chat_template.jinja");

function requireCommand(command: string) {
  if (!Bun.which(command)) {
    console.error(`${command} is not on PATH. See the requirements in README.md.`);
    process.exit(1);
  }
}

function run(command: string, args: string[]): number {
  return Bun.spawnSync([command, ...args], { stdio: ["inherit", "inherit", "inherit"] }).exitCode;
}

requireCommand("llama-server");

if (!(await Bun.file(gguf).exists()) || !(await Bun.file(template).exists())) {
  requireCommand("uvx");
  const status = run("uvx", [
    "--from", "huggingface_hub", "hf", "download", repo, ggufName,
    "chat_template.jinja", "LICENSE/ja", "LICENSE/en", "--local-dir", dir,
  ]);
  if (status !== 0) process.exit(status);
}

// GGUF に埋め込まれたテンプレートは古いので、同梱の chat_template.jinja を必ず使う（モデルカードの指示）。
// -c は 4 スロットで割られる。1 スロット 16384 トークンあれば、長い段落でも入力と訳の両方が収まる。
process.exit(run("llama-server", [
  "-m", gguf,
  "--chat-template-file", template,
  "--no-prefill-assistant",
  "--alias", "plamo-3-translate",
  "-c", "65536",
  "--parallel", "4",
  "--host", "127.0.0.1",
  "--port", port,
]));
