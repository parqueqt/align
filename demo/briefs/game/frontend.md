Build the game structure for "Batch", a browser game about getting a startup through a Y Combinator batch (plain canvas + ES modules in `src/`, no dependencies).

Gameplay idea: the founder moves through a 12-week batch, collects users, avoids burn-rate hazards, watches runway (months of money left), and wins by reaching Demo Day with enough users; running out of runway loses. You own the game logic: game loop, state, entities, collisions, levels/weeks, input, scoring, win/lose, and the events other code can react to.

Another developer's agent (Codex) owns the visual design (colors, sprites, HUD, screens, effects), and their developer will keep changing the design while you work. Keep logic and presentation cleanly separated so design changes never require editing your files and your changes never break theirs. Agree that boundary with the design agent early through align (which files each of you owns, what state and events the renderer can read), publish it to shared memory, answer their questions, and tell them when the state or events change. Bring in their work with `align.merge` when you need to check integration.

The game must run without errors when both of your work is merged. Commit with `align.commit`.
