import { describe, expect, test } from "bun:test";
import {
  draftsToQuestions,
  emptyDraft,
  groupIssues,
  nsToMs,
  PRESETS,
  parseState,
  pct,
  probabilityRows,
  questionsToDrafts,
} from "./decide";

describe("draftsToQuestions", () => {
  test("builds Ollaya's schema for all three question types", () => {
    const choice = emptyDraft("choice", "department");
    choice.instructions = "Which team?";
    choice.options = [
      { label: "billing", description: "Payments" },
      { label: "technical", description: "" },
      { label: " ", description: "ignored: no label" },
    ];
    const score = emptyDraft("score", "urgency");
    score.levels = ["Can wait", "", "Today"];
    const noul = emptyDraft("noul", "refund");
    noul.noulTrue = "Asks for a refund";

    const { questions, issues } = draftsToQuestions([choice, score, noul]);
    expect(issues).toEqual([]);
    expect(questions).toEqual({
      department: {
        type: "choice",
        instructions: "Which team?",
        criteria: { billing: "Payments", technical: null },
      },
      urgency: { type: "score", criteria: ["Can wait", "Today"] },
      refund: { type: "noul", criteria: { true: "Asks for a refund" } },
    });
  });

  test("a noul without descriptions sends no criteria at all", () => {
    expect(draftsToQuestions([emptyDraft("noul", "spam")]).questions).toEqual({
      spam: { type: "noul" },
    });
  });

  test("reports problems per question before any request is sent", () => {
    const tooFew = emptyDraft("choice", "a");
    tooFew.options = [{ label: "only", description: "" }];
    const dupLabels = emptyDraft("choice", "b");
    dupLabels.options = [
      { label: "x", description: "" },
      { label: "x", description: "" },
    ];
    const oneLevel = emptyDraft("score", "c");
    oneLevel.levels = ["just one"];
    const { issues } = draftsToQuestions([
      tooFew,
      dupLabels,
      oneLevel,
      emptyDraft("noul", ""),
      emptyDraft("noul", "a"),
    ]);
    expect(issues).toEqual([
      { index: 0, message: "A choice needs 2–255 options" },
      { index: 1, message: "Option labels must be unique" },
      { index: 2, message: "A score needs 2–10 levels" },
      { index: 3, message: "Give the question an id" },
      { index: 4, message: 'Duplicate id "a"' },
    ]);
  });

  test("an empty set is an issue of the whole set", () => {
    expect(draftsToQuestions([]).issues).toEqual([
      { index: -1, message: "Add at least one question" },
    ]);
  });
});

describe("questionsToDrafts", () => {
  test("round-trips every preset through the editor", () => {
    for (const preset of PRESETS) {
      const back = draftsToQuestions(questionsToDrafts(preset.questions));
      expect(back.issues).toEqual([]);
      // Array-style choice criteria come back as label → null descriptions.
      for (const [id, q] of Object.entries(preset.questions)) {
        expect(back.questions[id]?.type).toBe(q.type);
      }
    }
  });

  test("accepts label arrays for choices and non-string descriptions", () => {
    const [d] = questionsToDrafts({
      tone: { type: "choice", criteria: ["calm", "angry"], instructions: { lang: "en" } },
    });
    expect(d?.options).toEqual([
      { label: "calm", description: "" },
      { label: "angry", description: "" },
    ]);
    expect(d?.instructions).toBe('{"lang":"en"}');
  });

  test("rejects anything that isn't a questions object", () => {
    expect(() => questionsToDrafts([1])).toThrow(/object/);
    expect(() => questionsToDrafts({ q: { type: "rank" } })).toThrow(/choice, score or noul/);
  });
});

describe("parseState", () => {
  test("JSON objects and arrays are sent as JSON, everything else as text", () => {
    expect(parseState('{"subject":"Refund"}')).toEqual({ subject: "Refund" });
    expect(parseState(" [1, 2] ")).toEqual([1, 2]);
    expect(parseState("{not json")).toBe("{not json");
    expect(parseState("Plain text")).toBe("Plain text");
    expect(parseState("42")).toBe("42");
  });
});

describe("groupIssues", () => {
  test("question issues go to their id, the rest stays general", () => {
    const { byQuestion, general } = groupIssues([
      { loc: ["body", "questions", "intent", "choice", "criteria"], msg: "140 options do not fit" },
      { loc: ["body", "questions", "intent", "choice"], msg: "second" },
      { loc: ["body", "state"], msg: "part of state was dropped" },
      { msg: "no location" },
      { loc: ["body"], nomsg: true },
    ]);
    expect(byQuestion.get("intent")).toEqual(["140 options do not fit", "second"]);
    expect(general).toEqual(["state: part of state was dropped", "no location"]);
  });

  test("anything but an array yields nothing", () => {
    expect(groupIssues(undefined).general).toEqual([]);
  });
});

describe("formatting", () => {
  test("nanoseconds to readable milliseconds", () => {
    expect(nsToMs(486_370_688)).toBe("486 ms");
    expect(nsToMs(8_500_000)).toBe("8.5 ms");
    expect(nsToMs(33_609_034_182)).toBe("33.6 s");
    expect(nsToMs(undefined)).toBe("—");
  });

  test("percentages and probability rows", () => {
    expect(pct(0.9845)).toBe("98.5 %");
    expect(pct(null)).toBe("—");
    expect(probabilityRows({ billing: 0.98, technical: 0.02, broken: "x" })).toEqual([
      ["billing", 0.98],
      ["technical", 0.02],
    ]);
    expect(probabilityRows(null)).toEqual([]);
  });
});
