import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("DEV extension loaded", "info");
  });

  pi.registerCommand("devtest", {
    description: "Test development extension",
    handler: async (args, ctx) => {
      ctx.ui.notify(`devtest: ${args || "hello"}`, "info");
    },
  });
}
