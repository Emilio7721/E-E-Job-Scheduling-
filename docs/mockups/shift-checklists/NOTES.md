# Feature 1 — Shift checklists

Reference: Connecteam's **Checklists → Workflows** form editor
(`app.connecteam.com/index.html#/index/checklists/workflows/…`).

## What it is

Admins build a checklist out of fields. A manager then fills that checklist out
**every shift** — working down the list, checking off each item — and submits it
with a signature.

The example throughout the photos is *"Start of Shift Larsa Dishwasher
Checklist"*: 15 items covering supplies on hand (towels, sponges, soap) and
setup steps (drain closed, fill with water, safety on), ending in a confirmation
block and a required signature.

## Not the same as the app's existing "Documents"

The repo already has a feature under **More → Documents** (`forms`,
`form_submissions`). That one is: upload a PDF → place signature stamps on the
page → each person signs it **once**. Different thing entirely.

This new feature is: build a list of items in-app → someone works through it
**per shift, repeatedly**. It needs its own tables and its own menu entry, and
it should not be called "Forms" in the UI since **Documents** already owns that
space. Working name: **Checklists**.

## The builder side (admin)

Photos `01` and `02`.

- The checklist has a **title** — e.g. "Start of Shift Larsa Dishwasher Checklist".
- **Add field** dropdown, top right, appends a field.
- Fields are a **numbered, ordered list** (1–15 in the example), so order matters
  and must be editable.
- Field types visible, by icon:

  | Icon | Type | Example |
  | --- | --- | --- |
  | 📄 | Text / note block — information only, nothing to answer | #1 "Please make sure you have all these items and tha…" |
  | ✓ | Check item — the actual checklist rows | #2 Towels, #6 "Make sure dishwasher drain is closed at the bottom." |
  | 📄🔒 | "Confirmation" — a locked block, appears to be system-added | #14 |
  | ✏️ | Signature — marked `*`, i.e. **required** | #15 |

- Several labels end in **"(Read Description)"** — whoever wrote it is leaning on
  the description field to carry the longer instructions.
- Bottom bar: **Settings**, **Save as template**, **Save**.
- A **Mobile Preview** pane renders the phone view live beside the editor, with
  a **Reset preview** link.

## The filling side (manager, on a phone)

Photos `03`, `04`, `05` — all from the Mobile Preview pane.

- The title bar carries the checklist name.
- The intro text block renders large, italic, centred.
- Each check item shows:
  - **label** (e.g. "Towels")
  - optional **description** in grey underneath — this is where the real
    instruction lives, and it can be long. Photo `05`: *"Make sure all 3 soaps
    along the wall, under the dishwasher, are filled. 2 under the dishwasher
    alongside the wall. 1 by the dishwasher at eye level."*
  - two buttons: **Yes** and **Not Applicable**
- Note there is **no "No"** button — see open questions.
- A **Send** button sits at the bottom to submit the whole thing.

## Open questions

These block the design. Later photos may answer some.

1. **How does a checklist get attached to a shift?** Every job? Only jobs at a
   given venue? Only certain positions? Picked per job when scheduling?
2. **Start vs end of shift.** The title says "Start of Shift" — is that just
   naming, or a real setting with start-of-shift and end-of-shift checklists?
3. **Who is a "manager" here?** Admins only, or a position? (Positions now mirror
   the Jobs list, so "everyone with position X" is available as a rule.)
4. **Yes / Not Applicable with no "No".** Is that deliberate? If something is
   genuinely missing or broken, how does the manager flag it — and does anyone
   get notified?
5. **Is it blocking?** Does an unfinished checklist stop a clock-out, nag with a
   notification, or just sit incomplete?
6. **Who reviews submissions,** and what does that screen look like? Is there a
   history per shift / per venue?
7. **What is the locked "Confirmation" field** (#14)?
8. **Does "Not Applicable" need a reason** typed in?

## Photos

| Photo | What it shows |
| --- | --- |
| `01-form-editor-fields-1-9.jpg` | Editor, fields 1–9. Title, Add field, numbered rows, text block vs check items |
| `02-form-editor-fields-8-15.jpg` | Editor, fields 8–15. Ends with locked Confirmation and required Signature |
| `03-mobile-preview-intro-block.jpg` | Phone view: intro text block, first check item with description, Yes / Not Applicable, Send. Also shows Settings / Save as template / Save |
| `04-mobile-preview-yes-na-buttons.jpg` | Phone view: two consecutive items, one with a description and one without |
| `05-mobile-preview-long-description.jpg` | Phone view: a long multi-line description, showing how much text an item can carry |

Originals were 6000×8000 (~20 MB each); downscaled to 1650×2200 (~500 KB) so the
repo stays a sane size. Still fully legible.
