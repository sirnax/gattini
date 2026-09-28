import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function resolveStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const override = env.GATTINI_STATE_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override) || override.includes("\0")) throw new Error("GATTINI_STATE_DIR must be an absolute path");
    return override;
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "Gattini");
  if (platform === "linux") {
    const xdg = env.XDG_STATE_HOME;
    if (xdg !== undefined) {
      if (!isAbsolute(xdg) || xdg.includes("\0")) throw new Error("XDG_STATE_HOME must be an absolute path");
      return join(xdg, "gattini");
    }
    return join(home, ".local", "state", "gattini");
  }
  throw new Error(`Gattini state directory is not defined for ${platform}`);
}
