import { resolve } from "node:path";
import { startViewer } from "./server.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("用法：npm run viewer -- --project <项目路径>\n默认读取当前项目的 .pi/loop-in-loop；按 Ctrl+C 退出。");
} else {
  if (!(args.length === 0 || (args.length === 2 && args[0] === "--project" && args[1] && !args[1].startsWith("--")))) {
    console.error("用法：npm run viewer -- --project <项目路径>");
    process.exitCode = 1;
  } else {
    const project = resolve(args[1] ?? process.cwd());
    try {
      const viewer = await startViewer(project);
      console.log(`Pi-Recorder\n项目：${project}\n本地查看：${viewer.url}\n按 Ctrl+C 退出。`);
      const close = () => { void viewer.close().catch(console.error); };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
