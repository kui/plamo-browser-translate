// serve.ts をログオン時に起動するタスクを、Windows のタスクスケジューラで管理する。
// 使い方: bun run autostart install [2b|8b|0.8b|31b] | uninstall | start | stop
const taskName = "plamo-browser-translate";
const sizes = ["0.8b", "2b", "8b", "31b"];
const usage = "Usage: bun run autostart install [2b|8b|0.8b|31b] | uninstall | start | stop";

function powershell(script: string, env: Record<string, string> = {}) {
  const { exitCode } = Bun.spawnSync(
    // 明示しないと、SilentlyContinue で無視した失敗も終了コードに出る。
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}; exit 0`],
    { env: { ...process.env, ...env, TASK_NAME: taskName }, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (exitCode !== 0) process.exit(exitCode);
}

// Stop-ScheduledTask は先頭の conhost しか止めず、llama-server がポートとメモリを握ったまま残る。
const stop = `
  $task = Get-ScheduledTask -TaskName $env:TASK_NAME -ErrorAction SilentlyContinue
  if ($task) {
    $arguments = $task.Actions[0].Arguments
    Get-CimInstance Win32_Process |
      Where-Object { $_.Name -eq 'conhost.exe' -and $_.CommandLine -and $_.CommandLine.EndsWith($arguments) } |
      ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
  }
`;

// 既定の設定だと、実行から 3 日で止められ、バッテリー駆動では起動しない。
// 既定の優先度 7 は通常より低く、CPU が埋まっていると起動も翻訳も進まなくなる。
const register = `
  $action = New-ScheduledTaskAction -Execute conhost.exe -Argument $env:TASK_ARGUMENT -WorkingDirectory $env:TASK_DIR
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\\' + $env:USERNAME)
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 5
  Register-ScheduledTask -TaskName $env:TASK_NAME -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
`;
const start = "Start-ScheduledTask -TaskName $env:TASK_NAME";
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
switch (command) {
  case "install": {
    if (!sizes.includes(size)) {
      console.error(usage);
      process.exit(1);
    }
    // タスクは登録時の環境変数を引き継がないので、指定された値をコマンドに埋め込む。
    const sets = ["QUANT", "PORT", "SLEEP_IDLE_SECONDS"]
      .filter((name) => process.env[name])
      .map((name) => `set "${name}=${process.env[name]}"&& `)
      .join("");
    powershell(stop + register + start, {
      TASK_ARGUMENT: `--headless cmd /c "${sets}bun serve.ts ${size} > serve.log 2>&1"`,
      TASK_DIR: import.meta.dir,
    });
    console.log(`Registered and started task "${taskName}". Log: serve.log`);
    break;
  }
  case "uninstall":
    powershell(stop + unregister);
    console.log(`Removed task "${taskName}".`);
    break;
  case "start":
    powershell(start);
    console.log("Started. Log: serve.log");
    break;
  case "stop":
    powershell(stop);
    console.log("Stopped.");
    break;
  default:
    console.error(usage);
    process.exit(1);
}
