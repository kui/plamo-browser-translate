// serve.ts start をログオン時に実行するタスクを、Windows のタスクスケジューラに登録する。
// 使い方: bun run autostart install [2b|8b|0.8b|31b] | uninstall
const taskName = "plamo-browser-translate";
const sizes = ["0.8b", "2b", "8b", "31b"];
const usage = "Usage: bun run autostart install [2b|8b|0.8b|31b] | uninstall";

function powershell(script: string, env: Record<string, string> = {}) {
  const { exitCode } = Bun.spawnSync(
    // 明示しないと、SilentlyContinue で無視した失敗も終了コードに出る。
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}; exit 0`],
    { env: { ...process.env, ...env, TASK_NAME: taskName }, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (exitCode !== 0) process.exit(exitCode);
}

// 既定の設定だと、バッテリー駆動では起動しない。
// 既定の優先度 7 は通常より低く、CPU が埋まっていると起動も翻訳も進まなくなる。
const register = `
  $action = New-ScheduledTaskAction -Execute conhost.exe -Argument $env:TASK_ARGUMENT -WorkingDirectory $env:TASK_DIR
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\\' + $env:USERNAME)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 5
  Register-ScheduledTask -TaskName $env:TASK_NAME -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
`;
const unregister = `
  if (Get-ScheduledTask -TaskName $env:TASK_NAME -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $env:TASK_NAME -Confirm:$false
  }
`;

if (process.platform !== "win32") {
  console.error("autostart supports Windows only.");
  process.exit(1);
}

const [command, size = "2b"] = process.argv.slice(2);
if (command === "install" && sizes.includes(size)) {
  // 動かない設定を登録しないよう、先に起動を確かめる。ログオン時はこの結果が画面に出ない。
  const started = Bun.spawnSync([process.execPath, "serve.ts", "start", size], {
    cwd: import.meta.dir,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (started.exitCode !== 0) process.exit(started.exitCode);
  // タスクは登録時の環境変数を引き継がないので、指定された値をコマンドに埋め込む。
  const sets = ["QUANT", "PORT", "SLEEP_IDLE_SECONDS"]
    .filter((name) => process.env[name])
    .map((name) => `set "${name}=${process.env[name]}"&& `)
    .join("");
  powershell(register, {
    TASK_ARGUMENT: `--headless cmd /c "${sets}bun serve.ts start ${size} > serve.log 2>&1"`,
    TASK_DIR: import.meta.dir,
  });
  console.log(`Registered task "${taskName}".`);
} else if (command === "uninstall") {
  powershell(unregister);
  console.log(`Removed task "${taskName}". A running server keeps running; use "bun run serve stop" to stop it.`);
} else {
  console.error(usage);
  process.exit(1);
}
