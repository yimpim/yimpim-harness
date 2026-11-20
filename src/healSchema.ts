/**
 * The shape of a heal worker's reply, as a JSON schema, for models that can be held to one.
 *
 * Why it exists: Gemini, asked for plain JSON that looks like an action ({"need":[...]}) when no tools are declared, sometimes ends the call with
 * `MALFORMED_FUNCTION_CALL` and no text at all, because it tries to emit that action as a native function call. It repeats on the same request
 * (the same prompt failed 6 of 6 on each provider), and `tool_choice: "none"` did not stop it (0 of 6). Constrained to this schema (response_format
 * json_schema) the same two requests answered on the first attempt 12 of 12.
 *
 * The schema is a union with one branch per kind of reply, so each branch can REQUIRE what that kind of reply needs. A single loose object let the
 * model answer {"verdict":"stale-test"} and leave out the reason and the edits.
 */
const lookupItem = {
  type: "object",
  properties: { path: { type: "string" }, from: { type: "integer" }, to: { type: "integer" }, search: { type: "string" } },
};
const editItem = {
  type: "object",
  properties: { find: { type: "string" }, replace: { type: "string" } },
  required: ["find", "replace"],
};
const citeItem = { type: "object", properties: { at: { type: "string" }, quote: { type: "string" } }, required: ["at"] };
const strings = { type: "array", items: { type: "string" } };

const lookup = { type: "object", properties: { need: { type: "array", items: lookupItem } }, required: ["need"] };
const withEdits = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["stale-test", "mixed"] },
    reason: { type: "string" },
    edits: { type: "array", items: editItem },
    codeBugs: strings,
    cites: { type: "array", items: citeItem },
  },
  required: ["verdict", "reason", "edits"],
};
const withWholeFile = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["stale-test", "mixed"] },
    reason: { type: "string" },
    test: { type: "string" },
    codeBugs: strings,
    cites: { type: "array", items: citeItem },
  },
  required: ["verdict", "reason", "test"],
};
const claim = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["code-bug", "app-deviation", "unclear"] },
    reason: { type: "string" },
    codeBugs: strings,
    appDeviations: strings,
    cites: { type: "array", items: citeItem },
  },
  required: ["verdict", "reason"],
};
const park = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["park"] }, kind: { type: "string", enum: ["unsure", "code"] }, reason: { type: "string" } },
  required: ["verdict", "kind", "reason"],
};

export const HEAL_REPLY_SCHEMA = { anyOf: [lookup, withEdits, withWholeFile, claim, park] };
export const HEAL_REPLY_STRUCTURED = { name: "heal_reply", schema: HEAL_REPLY_SCHEMA };
