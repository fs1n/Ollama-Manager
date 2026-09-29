// Pure logic behind the Decide page: converting between the question editor's
// drafts and Ollaya's question schema (docs/api.md §5), reading the state
// input, mapping validation issues back to questions, and presets. No DOM
// access here, so it is testable with plain bun:test.

export type QuestionType = "choice" | "score" | "noul";

/** One row of a choice question: label → description (description optional) */
export interface ChoiceOption {
  label: string;
  description: string;
}

export interface QuestionDraft {
  id: string;
  type: QuestionType;
  instructions: string;
  /** choice: labels with descriptions */
  options: ChoiceOption[];
  /** score: level descriptions, level 0 first */
  levels: string[];
  /** noul: optional descriptions of the two outcomes */
  noulTrue: string;
  noulFalse: string;
}

/** Ollaya's wire format for one question */
export interface ApiQuestion {
  type: QuestionType;
  instructions?: unknown;
  criteria?: unknown;
}

export type ApiQuestions = Record<string, ApiQuestion>;

export function emptyDraft(type: QuestionType = "choice", id = ""): QuestionDraft {
  return {
    id,
    type,
    instructions: "",
    options: [
      { label: "", description: "" },
      { label: "", description: "" },
    ],
    levels: ["", ""],
    noulTrue: "",
    noulFalse: "",
  };
}

// Limits from docs/api.md §5.2 — checked here too so obvious mistakes show up
// before a round trip, next to the field that has them.
export const LIMITS = {
  questions: 256,
  choiceMin: 2,
  choiceMax: 255,
  scoreMin: 2,
  scoreMax: 10,
} as const;

export interface DraftIssue {
  /** index of the question in the draft list, or -1 for the whole set */
  index: number;
  message: string;
}

/**
 * Builds the `questions` object for /api/decide. Returns the issues instead
 * when the drafts can't form a valid request.
 */
export function draftsToQuestions(drafts: QuestionDraft[]): {
  questions: ApiQuestions;
  issues: DraftIssue[];
} {
  const issues: DraftIssue[] = [];
  const questions: ApiQuestions = {};
  if (drafts.length === 0) issues.push({ index: -1, message: "Add at least one question" });
  if (drafts.length > LIMITS.questions) {
    issues.push({ index: -1, message: `At most ${LIMITS.questions} questions` });
  }
  const seen = new Set<string>();

  drafts.forEach((d, index) => {
    const id = d.id.trim();
    if (!id) {
      issues.push({ index, message: "Give the question an id" });
      return;
    }
    if (seen.has(id)) {
      issues.push({ index, message: `Duplicate id "${id}"` });
      return;
    }
    seen.add(id);

    const q: ApiQuestion = { type: d.type };
    // Without instructions Ollaya reads the id instead (docs/api.md §5.2).
    if (d.instructions.trim()) q.instructions = d.instructions.trim();

    if (d.type === "choice") {
      const options = d.options.filter((o) => o.label.trim());
      const labels = options.map((o) => o.label.trim());
      if (new Set(labels).size !== labels.length) {
        issues.push({ index, message: "Option labels must be unique" });
      }
      if (options.length < LIMITS.choiceMin || options.length > LIMITS.choiceMax) {
        issues.push({
          index,
          message: `A choice needs ${LIMITS.choiceMin}–${LIMITS.choiceMax} options`,
        });
      }
      const criteria: Record<string, string | null> = {};
      for (const o of options) criteria[o.label.trim()] = o.description.trim() || null;
      q.criteria = criteria;
    } else if (d.type === "score") {
      const levels = d.levels.map((l) => l.trim()).filter(Boolean);
      if (levels.length < LIMITS.scoreMin || levels.length > LIMITS.scoreMax) {
        issues.push({
          index,
          message: `A score needs ${LIMITS.scoreMin}–${LIMITS.scoreMax} levels`,
        });
      }
      q.criteria = levels;
    } else {
      const t = d.noulTrue.trim();
      const f = d.noulFalse.trim();
      if (t || f) q.criteria = { ...(t ? { true: t } : {}), ...(f ? { false: f } : {}) };
    }
    questions[id] = q;
  });

  return { questions, issues };
}

const text = (v: unknown): string =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v);

/** Turns a `questions` object (from JSON or a model's built-ins) into drafts. */
export function questionsToDrafts(questions: unknown): QuestionDraft[] {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw new Error("Questions must be an object of id → question");
  }
  return Object.entries(questions as Record<string, unknown>).map(([id, raw]) => {
    const q = (raw ?? {}) as { type?: unknown; instructions?: unknown; criteria?: unknown };
    if (q.type !== "choice" && q.type !== "score" && q.type !== "noul") {
      throw new Error(`Question "${id}": type must be choice, score or noul`);
    }
    const d = emptyDraft(q.type, id);
    d.instructions = text(q.instructions);
    if (q.type === "choice") {
      if (Array.isArray(q.criteria)) {
        d.options = q.criteria.map((l) => ({ label: text(l), description: "" }));
      } else if (q.criteria && typeof q.criteria === "object") {
        d.options = Object.entries(q.criteria).map(([label, desc]) => ({
          label,
          description: text(desc),
        }));
      }
    } else if (q.type === "score" && Array.isArray(q.criteria)) {
      d.levels = q.criteria.map(text);
    } else if (q.type === "noul" && q.criteria && typeof q.criteria === "object") {
      const c = q.criteria as { true?: unknown; false?: unknown };
      d.noulTrue = text(c.true);
      d.noulFalse = text(c.false);
    }
    return d;
  });
}

/**
 * The state input: JSON objects and arrays are sent as JSON (Ollaya accepts
 * any JSON string, object or array), everything else as the plain string.
 */
export function parseState(input: string): string | object {
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const v = JSON.parse(trimmed);
      if (v && typeof v === "object") return v;
    } catch {
      // not JSON after all — send the text as it is
    }
  }
  return input;
}

/** One validation issue in TypeSafe's shape, as Ollaya returns them (§4.4). */
export interface ApiIssue {
  loc?: unknown[];
  msg?: string;
}

/**
 * Sorts validation issues into "per question id" and "everything else", so
 * the page can show each message next to the question it is about. Question
 * issues have loc ["body", "questions", <id>, …].
 */
export function groupIssues(detail: unknown): {
  byQuestion: Map<string, string[]>;
  general: string[];
} {
  const byQuestion = new Map<string, string[]>();
  const general: string[] = [];
  if (!Array.isArray(detail)) return { byQuestion, general };
  for (const raw of detail) {
    const issue = raw as ApiIssue;
    if (typeof issue?.msg !== "string") continue;
    const loc = Array.isArray(issue.loc) ? issue.loc : [];
    if (loc[0] === "body" && loc[1] === "questions" && typeof loc[2] === "string") {
      const list = byQuestion.get(loc[2]) ?? [];
      list.push(issue.msg);
      byQuestion.set(loc[2], list);
    } else {
      const where = loc.filter((p) => p !== "body").join(".");
      general.push(where ? `${where}: ${issue.msg}` : issue.msg);
    }
  }
  return { byQuestion, general };
}

/** Durations in Ollaya responses are nanoseconds. */
export function nsToMs(ns: unknown): string {
  if (typeof ns !== "number" || !Number.isFinite(ns)) return "—";
  const ms = ns / 1e6;
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

export function pct(p: unknown): string {
  return typeof p === "number" && Number.isFinite(p) ? `${(p * 100).toFixed(1)} %` : "—";
}

/** Probabilities as [label, p] pairs in the order Ollaya returned them. */
export function probabilityRows(probabilities: unknown): [string, number][] {
  if (!probabilities || typeof probabilities !== "object") return [];
  return Object.entries(probabilities as Record<string, unknown>).filter(
    (e): e is [string, number] => typeof e[1] === "number",
  );
}

export interface Preset {
  id: string;
  label: string;
  state: string;
  questions: ApiQuestions;
}

export const PRESETS: Preset[] = [
  {
    id: "triage",
    label: "Support triage",
    state:
      "Third time this year you've double-charged me. Refund it today or I'm cancelling and moving to a competitor.",
    questions: {
      department: {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: {
          billing: "Payments, invoices and refunds",
          technical: "Bugs, errors and outages",
          account: "Login, profile and settings",
        },
      },
      urgency: {
        type: "score",
        instructions: "How urgent is this ticket?",
        criteria: ["Can wait", "Needs attention this week", "Needs attention today"],
      },
      refund_requested: {
        type: "noul",
        instructions: "The customer asks for money back.",
      },
      churn_risk: {
        type: "noul",
        instructions: "The customer threatens to leave.",
      },
    },
  },
  {
    id: "moderation",
    label: "Content moderation",
    state: "Anyone who disagrees with me is an idiot and should be banned from this forum.",
    questions: {
      toxicity: {
        type: "score",
        instructions: "How toxic is this message?",
        criteria: ["Not toxic", "Mildly rude", "Insulting", "Hateful or threatening"],
      },
      personal_attack: {
        type: "noul",
        instructions: "The message attacks a person or group rather than an argument.",
      },
      action: {
        type: "choice",
        instructions: "What should a moderator do?",
        criteria: {
          allow: "Leave the message as it is",
          warn: "Warn the author",
          remove: "Remove the message",
        },
      },
    },
  },
  {
    id: "sentiment",
    label: "Review sentiment",
    state: "The battery lasts forever, but the screen scratches way too easily.",
    questions: {
      sentiment: {
        type: "choice",
        instructions: "Overall sentiment of the review",
        criteria: ["positive", "mixed", "negative"],
      },
      stars: {
        type: "score",
        instructions: "How many stars would the reviewer give?",
        criteria: ["1 star", "2 stars", "3 stars", "4 stars", "5 stars"],
      },
    },
  },
];
