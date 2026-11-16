/**
 * Parses the Discovery agent's final JSON answer (its `taskFindings` object)
 * out of free-form model output. Pulled out of src/index.ts as a standalone,
 * side-effect-free module so it can be unit tested directly — index.ts runs
 * its whole CLI on import.
 */

/**
 * Tried in order: a fenced ```json block, then a raw `{...}` span, then the
 * whole text — a fast/small Discovery model frequently prefaces its JSON with
 * a line of prose despite being told not to, and treating that as a hard
 * failure would throw away a pass that actually did find real files. Logs a
 * warning (with a snippet of what Discovery actually returned) exactly once
 * when NOTHING parses, so an empty Planner allowlist is traceable to its
 * cause instead of looking like Discovery silently found nothing.
 */
export function parseDiscoveryJson(discoveryOutput: string): any | undefined {
  const fenced = discoveryOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const braceSpan = discoveryOutput.match(/(\{[\s\S]*\})/);
  const candidates = [fenced?.[1], braceSpan?.[1], discoveryOutput].filter(
    (c): c is string => typeof c === "string"
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next, looser candidate.
    }
  }
  console.warn(
    `[DISCOVERY] ⚠️ Could not parse a taskFindings JSON object out of Discovery's final answer — ` +
      `Planner will get an empty file allowlist. Discovery returned:\n` +
      `${discoveryOutput.slice(0, 500)}${discoveryOutput.length > 500 ? "... (truncated)" : ""}`
  );
  return undefined;
}

export function extractTaskFindings(discoveryOutput: string): string {
  const parsed = parseDiscoveryJson(discoveryOutput);
  return JSON.stringify(
    parsed?.taskFindings ?? {
      existingFiles: [],
      existingFlow: [],
      newFilesNeeded: [],
      uncertainties: ["Discovery did not return a parseable taskFindings object; do not guess file ownership."],
    },
    null,
    2
  );
}

/**
 * The exact paths Planner's bounded inspection is allowed to open —
 * `taskFindings.existingFiles`, the same list already surfaced to it as
 * prose in the plannerPrompt. Never `newFilesNeeded`: those don't exist yet,
 * so a read_file/get_symbol_definition call against one would only ever
 * fail. Same tolerant parsing as extractTaskFindings — a Discovery output
 * that doesn't parse just means an empty allowlist (every Planner
 * inspection refused, with a clear reason, logged by parseDiscoveryJson),
 * not a crash.
 */
export function extractDiscoveryTargetFiles(discoveryOutput: string): string[] {
  const files = parseDiscoveryJson(discoveryOutput)?.taskFindings?.existingFiles;
  if (!Array.isArray(files)) return [];
  return files.map((f: any) => f?.path).filter((p: any) => typeof p === "string" && p.length > 0);
}

/**
 * Discovery sometimes runs out of turns and its forced last answer comes back
 * empty. Everything it read was then thrown away, the Planner got an empty file
 * allowlist, and planned from guesses. The files it DID read are known, though,
 * so when its answer carries no usable file list, one is rebuilt from them.
 *
 * It is labelled for what it is: files Discovery read, not a verified list of
 * the ones to change, with an uncertainty saying so. An answer that already has
 * a file list is returned untouched.
 */
export function recoverDiscoveryOutput(discoveryOutput: string, filesRead: string[]): string {
  const fenced = discoveryOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/g) ?? [];
  const spans = [...fenced.map((f) => f.replace(/^```(?:json)?\s*|\s*```$/g, "")), (discoveryOutput.match(/(\{[\s\S]*\})/) ?? [])[1]];
  for (const c of spans) {
    if (!c) continue;
    try {
      const files = JSON.parse(c)?.taskFindings?.existingFiles;
      if (Array.isArray(files) && files.some((f: any) => typeof f?.path === "string" && f.path)) return discoveryOutput;
    } catch {
      // not JSON; keep looking
    }
  }
  if (filesRead.length === 0) return discoveryOutput;
  const recovered = {
    taskFindings: {
      existingFiles: filesRead.map((p) => ({
        path: p,
        symbols: [],
        relevantCode: "Read by Discovery before it ran out of turns; its findings on this file were not written up.",
        whyRelevant: "Unconfirmed: Discovery read it while looking for the code this task changes.",
      })),
      existingFlow: [],
      newFilesNeeded: [],
      uncertainties: [
        "Discovery ran out of turns before concluding. These are the source files it read, not a verified list of the ones to change; read them before relying on any of them.",
      ],
    },
  };
  // First, because the parser reads the first findings block it finds: an
  // empty one left in Discovery's own text must not shadow this one.
  return `\`\`\`json\n${JSON.stringify(recovered, null, 2)}\n\`\`\`\n\n${discoveryOutput}`;
}

/**
 * Discovery's `taskFindings` object, parsed without the warning
 * parseDiscoveryJson prints when nothing parses. For callers that look at it
 * after the fact (what to remember once a task passed) rather than act on it.
 */
export function parseTaskFindingsQuiet(output: string): any | undefined {
  const fenced = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)].map((m) => m[1]);
  const span = output.match(/(\{[\s\S]*\})/)?.[1];
  for (const c of [...fenced, span, output]) {
    if (!c) continue;
    try {
      const f = JSON.parse(c)?.taskFindings;
      if (f) return f;
    } catch {
      // try the next
    }
  }
  return undefined;
}
