/**
 * Stage — kind correction for directory reads (KIND_CORRECTION). Rule 10.
 *
 * The "wrong door" mistake: the model points a file READER at a directory
 * (host answers "not a regular file"/EISDIR). The intent is unambiguous —
 * nobody reads a folder by accident, they want its contents — so the stage
 * re-dispatches the same path to a LISTING tool that the agent's own tool
 * plane offers, with arguments built from that tool's own definition
 * (repair/kind-correction). No listing tool in scope, or no unique
 * directory in the failed call: the original error stands, loudly.
 *
 * The write-to-a-missing-directory half of this family needs no correction:
 * the host's write already creates parent directories (probed), so there is
 * nothing here to heal — recorded so the next reader does not re-derive it.
 *
 * @module dsh-tool-doctor/stages/kind-fix
 */

import type { PostStage, RecoveryOutcome, StageEnv } from "../core/stage.ts";
import type { ToolDispatchExecution } from "../types.ts";
import { errorCode, resultErrorText } from "../core/result.ts";
import { visibleToolNames } from "../core/tool-names.ts";
import { executeNestedTool } from "../recovery/nested-dispatch.ts";
import {
  chooseListingTool,
  directoryFromArgs,
  isDirectoryAccessError,
  listingArgsFor,
} from "../repair/kind-correction.ts";

/** Tool-name shapes that READ a path: contains "read" or is a viewer alias. */
function isReadFamily(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name.includes("read") || ["view", "cat", "open", "str_replace_editor"].includes(name);
}

interface KindPayload {
  listingTool: string;
  listingArgs: Record<string, unknown>;
  dir: string;
}

export const kindFixStage: PostStage = {
  phase: "post",
  id: "kind-fix",
  label: "Directory-read kind correction (KIND_CORRECTION)",
  ruleNumber: 10,
  enabledBy: "autoKindFixes",
  category: "KIND_CORRECTION",
  roundTrips: 1,
  matchesError: isDirectoryAccessError,
  terminal: true,
  inspect(exec, result, env) {
    if (!env.config.autoKindFixes || !env.tools) return undefined;
    if (!isReadFamily(exec.name)) return undefined;
    if (result.isError !== true) return undefined;
    if (!isDirectoryAccessError(errorCode(result.error), resultErrorText(result))) {
      return undefined;
    }
    const dir = directoryFromArgs(exec.arguments);
    if (dir === undefined) return undefined;
    const names = visibleToolNames(env.tools, exec);
    if (names === undefined) return undefined;
    const listingTool = chooseListingTool(names);
    if (listingTool === undefined || listingTool === exec.name) return undefined;
    const listingArgs = listingArgsFor(env.tools.get(listingTool, exec.agent, exec.toolSet), dir);
    if (listingArgs === undefined) return undefined;
    return { listingTool, listingArgs, dir } satisfies KindPayload;
  },
  async recover(
    exec: ToolDispatchExecution,
    env: StageEnv,
    payload,
  ): Promise<RecoveryOutcome | undefined> {
    const { listingTool, listingArgs, dir } = payload as KindPayload;
    const result = await executeNestedTool(
      exec,
      env.tools!,
      listingTool,
      listingArgs,
      `kind-list-${listingTool}`,
    );
    if (result.isError === true) return undefined; // listing failed too: error stands
    return {
      result,
      args: listingArgs,
      preview: `Listed ${dir} via ${listingTool}`,
      changeLabel: `Read "${exec.name}" hit a directory; listed it via "${listingTool}" instead`,
    };
  },
};
