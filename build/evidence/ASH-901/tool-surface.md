# AR5 model-facing tool detector foundation

The detector compares captured DSH tool lists with a fake device offline and online. It requires the five named ash tools exactly once, rejects any extra ash tool, rejects fake-device aliases appearing as direct tools, and rejects a surface that changes with device availability. It fails on empty captures or an absent fake-device alias list. Unrelated native DSH tools may remain; AR5 constrains the ash surface and device projection, not all DSH internals.

Four executable fixture tests include a healthy two-state capture plus deliberate missing, extra, duplicated, directly projected, and vacuous cases. This is **detector validation only**. AR5 production acceptance requires capture from the real DSH binding and a fake-host manifest-derived alias catalogue; callers may not supply an arbitrary alias list that hides projected tools.

Reproduce: `node --import tsx --test packages/core/test/arch/tool-surface.test.ts`. A full `npm test` run includes this file.
