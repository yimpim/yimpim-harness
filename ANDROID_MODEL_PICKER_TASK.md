# Task: model picker for the new roles (logo designer, logo judge, security)

**For:** phone dev (Android + Expo) · **From:** desktop · **Spec:** `docs/REMOTE_SPEC.md` §5 `model.config`, `model.catalog`, §6 `list_models`, `set_model`

## What changed on the desktop

Three new model roles exist, and the picker has to show and edit them. Nothing about the existing nine roles changes.

| role | label on screen | kind | optional | needs |
|---|---|---|---|---|
| `designer` | Logo designer | **a set of 1 to 6 models** | yes | any text model |
| `designerVision` | Logo judge (Vision) | **a set of 1 to 4 models** | yes | vision-capable models only |
| `security` | Security | primary + one backup (like the others) | yes | any text model |

"A set" means the desktop rotates through the models: different models propose and draw different logo concepts, because one model alone settles into one style. The order of a set does not matter. A normal role is a primary and an optional backup.

## The one rule to follow: build the picker from `roleInfo`, not from a list in the app

`model.config` now carries a `roleInfo` array that describes every role, in display order:

```json
{
  "kind": "model.config",
  "scope": "global",
  "roles": [
    { "role": "editor", "chain": ["anthropic/claude-3.5-sonnet", "openai/gpt-4o"] },
    { "role": "designer", "chain": ["openai/gpt-5", "google/gemini-3", "anthropic/claude-opus-5"] },
    { "role": "designerVision", "chain": [] },
    { "role": "security", "chain": [] }
  ],
  "roleInfo": [
    { "role": "editor", "label": "Editor", "blurb": "Writes the actual code. Needs tool calling. HIGHEST token volume.",
      "optional": false, "multi": null, "needsTools": true, "needsVision": false, "volume": "high" },
    { "role": "designer", "label": "Logo designer", "blurb": "The models that propose and draw logo and brand concepts, rotated ...",
      "optional": true, "multi": { "min": 1, "max": 6 }, "needsTools": false, "needsVision": false, "volume": "low" }
  ]
}
```

(abbreviated; `roleInfo` has one entry per role in `roles`.)

- **Role list:** one row per `roleInfo` entry, in that order. Row title = `label`; subtitle = the chain joined with `  →  ` for a normal role, or the models joined with `, ` for a set role (show "not set" for an empty chain). Mark a set role so it is clear it holds several (the web page uses "Logo designer (set)").
- **Do not hard-code roles, labels or the optional/set flags.** The desktop will add roles over time; a role the app has never heard of must appear and work, using only what `roleInfo` says.
- **Old desktop:** `roleInfo` is absent. Fall back to the nine original roles with the labels and optional flags the app already has. Never crash on a missing field.
- **Unknown extra fields:** ignore them (use lenient JSON parsing: `ignoreUnknownKeys` in kotlinx.serialization, the default in Gson/Moshi-lenient, plain objects in Expo).

## The two pickers

### Normal role (`multi` is `null`), unchanged

1. `list_models` with `{ role }`, show candidates, user picks the **primary**.
2. `list_models` again with `{ role, exclude: [primary] }`, user picks a **backup** or "No backup".
3. `set_model` with `{ role, chain: [primary] }` or `{ role, chain: [primary, backup] }`.
4. If `optional` is true and the role currently has a chain, offer **Unset**, which sends `chain: []`.

### Set role (`multi` is `{ min, max }`), new

1. One `list_models` with `{ role }` (no `exclude`). Candidates are already filtered for the role (the judge shows vision models only).
2. Multi-select list: tap a model to add it (show a tick), tap again to remove it. Start with the role's current chain ticked.
3. Show a live summary "Selected N of up to MAX" and the selected ids. **Do not let the user select more than `multi.max`** (ignore extra taps or disable them).
4. **Save** is disabled until at least `multi.min` (1) is selected. It sends `set_model` with `{ role, chain: [ ...selected ] }`.
5. If `optional` is true and the role currently has a chain, offer **Unset (back to default)**, sending `chain: []`.
6. Show `roleInfo.blurb` at the top of the picker. It explains what to choose (for the logo roles: pick different providers).

The web phone page (`src/remote/ui.ts`, search for `modelView==='multi'`) is a working reference implementation of both pickers. Match its behaviour.

## Responses and errors (same as today)

- On success the desktop sends a fresh `model.config` (with `roleInfo`). **Update the UI only from that**, never optimistically. Return to the role list.
- `command.refused` for `set_model` must be shown inside the picker (not the generic composer path). New refusal reasons you may see, all plain text to display as-is:
  - `"Logo designer takes at most 6 models."` (more than `multi.max`)
  - `"<Role> takes a primary and at most one backup."` (a normal role sent 3 or more)
  - `"The same model is listed twice."`
  - `"A model id is empty."`
  - the existing ones: a task is running (changing models is blocked), a required role left empty.
- `model.catalog_unavailable` shows its `reason` with a way back, as today.
- Ignore a `model.catalog` whose `role` is not the one the picker is showing (the existing rule).
- `list_models` can be slow (a live OpenRouter fetch): show a spinner.

## Acceptance checks

1. Against a desktop with these roles, the role list shows **12 rows** (nine original plus Logo designer, Logo judge, Security), in the order `roleInfo` gives.
2. Logo designer shows its current models joined with commas; tapping opens the multi-select with them ticked.
3. In the multi-select you can tick up to 6 (designer) and 4 (judge) and no more; Save is disabled at 0; Save sends the whole set.
4. Logo judge lists only vision-capable models (the desktop filters this; do not re-filter).
5. Security behaves exactly like Planner/Verifier: primary, then backup or "No backup".
6. Unset is offered for all three new roles when they have a value, and sends `chain: []`.
7. Add a fake role to a test `model.config` (`roleInfo` entry with a name the app has never seen, `multi: null`): it appears and its picker works with no code change.
8. Against an older desktop (no `roleInfo`): exactly the nine original roles, as before, no crash.
9. A refused `set_model` (try it while a task is running) shows the reason inside the picker.
10. The set is saved by the desktop in `models.designer` / `models.designerVision` as a YAML list, and shows again after reopening the picker.

## Notes

- The phone cannot tell the desktop which scope to write to; that is unchanged.
- The desktop's own `/model` command now offers the same three roles and builds a set by asking for models one at a time ("model 2 of up to 6", Enter to finish).
- These three roles are **not** asked during the desktop's first-run setup; they are set from `/model` or from this picker, and they fall back to the Planner's / Verifier's models when unset (the blurb says so).
- Reserved for later, **do not build yet**: a role for image-generation models used in a logo "competition". It would use the same `multi` mechanism, so a picker built from `roleInfo` needs no change when it arrives.
