# Mockups & reference photos

Drop screenshots, photos, and sketches here for features that haven't been built
yet. Anything in this folder is reference material for whoever implements the
feature — it isn't shipped to the app.

## How to add photos

1. **One folder per feature.** Rename `feature-1/` and `feature-2/` to something
   descriptive (`shift-swaps/`, `tip-pooling/`), or add new folders the same way.
2. **Number the files in flow order**, two digits first:
   `01-entry-screen.png`, `02-list-view.png`, `03-detail-empty-state.png`.
   Order is how the screens connect — without it, a pile of screenshots is
   ambiguous about what leads to what.
3. **Fill in that folder's `NOTES.md`.** Even five bullets helps a lot. Photos
   show *what it looks like*; the notes say *what it's for and how it behaves*.

## Working through them

Photos are expensive to read — roughly 20–40 can be looked at carefully in one
sitting before there's no room left to actually write code. So the build goes
one feature at a time:

1. Read that feature's photos and `NOTES.md`.
2. Write a spec into the feature folder as `SPEC.md` and confirm it.
3. Build against the confirmed spec.

Keeping the spec in the repo means the understanding survives even after the
images themselves scroll out of context.

## File format

PNG or JPG. Phone screenshots are fine as-is — no need to resize or compress.
Photos of a whiteboard or paper sketch work too; just make sure the writing is
legible.
