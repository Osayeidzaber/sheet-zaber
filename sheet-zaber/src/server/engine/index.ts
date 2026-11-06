import "server-only"

/*
 * The public data engine's single entry point (`backend-api-contract.md` §1, §4.8).
 *
 * `/api/v1/**` and `POST /api/internal/playground` are two thin adapters over THIS function and
 * import nothing else from this directory — that is what makes the playground's answer byte-identical
 * to a real client's (`architecture.md` §3).
 */

export { handleEngineCall } from "./handle"
export type { EngineAuth, EngineCall, EngineDeps, EngineOutcome } from "./types"
