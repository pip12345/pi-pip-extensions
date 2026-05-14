/**
 * Hide Working Indicator Extension
 *
 * Disables pi's built-in inline "Working..." loader row so the input/footer
 * area does not jump when streaming starts in terminals like VS Code.
 */

type ExtensionAPI = any;

export default function (pi: ExtensionAPI) {
  // Keep minimal-footer's token counter above the editor when this extension is enabled.
  process.env.PI_MINIMAL_FOOTER_TOKEN_COUNTER_PLACEMENT = "aboveEditor";

  function hideWorking(ctx: any): void {
    if (!ctx?.hasUI) return;
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingIndicator({ frames: [] });
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    hideWorking(ctx);
  });

  // Re-apply around turn startup in case another extension or reload restored it.
  pi.on("agent_start", async (_event: any, ctx: any) => {
    hideWorking(ctx);
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    hideWorking(ctx);
  });
}
