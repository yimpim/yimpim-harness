/**
 * When the design system has just been made inside a roadmap, the work it leaves (the icon set, the empty, loading and error states, the app icon and logo) becomes units in the
 * roadmap's "Design" area, not free text in a summary nobody acts on. They depend on the "Design system" unit when the roadmap has one. Existing units are never duplicated.
 */
import { addUnits, loadRoadmap, progress, saveRoadmap, type UnitDraft } from "./roadmap.js";
import { DESIGN_UNIT_TITLE } from "./intake.js";

export const DESIGN_AREA = "Design";

/** The follow-up units for a design system that was just made: what it names, plus the two every app needs. */
export function designFollowUps(made: { summary: string; files: string[] }): UnitDraft[] {
  const mentionsIcons = /icon/i.test(made.summary) || made.files.some((f) => /icon/i.test(f));
  const drafts: UnitDraft[] = [];
  if (mentionsIcons) {
    drafts.push({
      title: "Icon set",
      area: DESIGN_AREA,
      summary: "Add the icon set the design system names and use it for every icon in the app, so icons look like one family.",
      buildsUi: false,
      acceptance: ["The icon set named in design-system/ is installed or added", "Every icon in the app comes from it"],
    });
  }
  drafts.push(
    {
      title: "Empty, loading and error states",
      area: DESIGN_AREA,
      summary: "Design and build what a person sees when there is nothing yet, while something loads, and when something goes wrong, following the design system.",
      buildsUi: true,
      acceptance: ["Every list or screen that can be empty has a designed empty state", "Loading and error states look like the rest of the app"],
    },
    {
      title: "App icon and logo",
      area: DESIGN_AREA,
      summary: "Make the app icon and logo (the design route), from design-system/BRIEF.md and the design system, unless the person already gave one.",
      buildsUi: false,
      acceptance: ["An app icon exists in every size the platforms need", "The logo matches the design system's colours"],
    }
  );
  return drafts;
}

/** Adds them to the project's active, unfinished roadmap. Returns how many units were added: 0 with no roadmap, a finished one, or when they are already there. */
export function addDesignFollowUps(repoRoot: string, made: { summary: string; files: string[] }): number {
  const rm = loadRoadmap(repoRoot);
  if (!rm) return 0;
  const p = progress(rm);
  if (p.total > 0 && p.done === p.total) return 0;
  const hasDesignUnit = rm.units.some((u) => u.title.trim().toLowerCase() === DESIGN_UNIT_TITLE.toLowerCase());
  const drafts = designFollowUps(made).map((d) => ({ ...d, deps: hasDesignUnit ? [DESIGN_UNIT_TITLE] : [] }));
  const res = addUnits(rm, drafts, "plan");
  if (res.added.length > 0) saveRoadmap(repoRoot, rm);
  return res.added.length;
}
