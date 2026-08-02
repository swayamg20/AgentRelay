import { z } from "zod";

/**
 * Extensible A2A artifact envelope accepted by the relay. MCP authors get a
 * stricter built-in union, while direct protocol clients may introduce typed
 * artifacts without making an older relay reject the whole thread.
 */
export const mailboxArtifactSchema = z.object({ type: z.string().min(1) }).passthrough();
