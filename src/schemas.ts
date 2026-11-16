export const discoverySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ready", "needs_clarification"] },
    summary: { type: "string" },
    affectedFiles: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { path: { type: "string" }, reason: { type: "string" } },
        required: ["path", "reason"]
      }
    },
    possiblyAffectedFiles: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { path: { type: "string" }, reason: { type: "string" } },
        required: ["path", "reason"]
      }
    },
    questions: { type: "array", items: { type: "string" }, maxItems: 4 }
  },
  required: ["status", "summary", "affectedFiles", "possiblyAffectedFiles", "questions"]
};

export const planSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    phases: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          goal: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          changes: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } }
        },
        required: ["id", "name", "goal", "files", "changes", "verification"]
      }
    }
  },
  required: ["goal", "assumptions", "phases"]
};

export const verificationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["passed", "failed"] },
    summary: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          requirement: { type: "string" },
          status: { type: "string", enum: ["satisfied", "missing", "uncertain"] },
          evidence: { type: "string" }
        },
        required: ["requirement", "status", "evidence"]
      }
    },
    issues: { type: "array", items: { type: "string" } }
  },
  required: ["status", "summary", "requirements", "issues"]
};
