import { openCodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";

export const adapters = {
  opencode: openCodeAdapter,
  pi: piAdapter,
} as const;
