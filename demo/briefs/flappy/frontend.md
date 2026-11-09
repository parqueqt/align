Build "Demo Day Flight", a one-button browser game in the flappy genre with a Y Combinator theme (plain canvas + ES modules in `src/`, no dependencies). Original name and art: do not copy any existing game's assets.

The player is a small bird carrying a startup. Tap/Space flaps against gravity; the bird flies through gaps between obstacles (stacks of "pitch decks" and "term sheets"). Each gap passed is +1 traction; hitting an obstacle or the ground ends the run; reaching 20 traction is Demo Day (win).

You own the game logic and the bird: loop, physics, input, obstacles, collisions, scoring, win/lose, and drawing the bird.

Your developer James has made a design call: **the bird is green**. Record that as James's decision through align before building the bird, and draw it that way.

Another developer's agent (Codex) owns the rest of the visual design (background, obstacle art, HUD, start/win/lose screens) and their developer will keep sending design requests. Agree the boundary with them early through align (files each of you owns, the state and events their rendering can read), publish it to shared memory, and keep it current. Bring in their work with `align.merge` to check integration.

The game must run without errors with both of your work merged. Commit with `align.commit`.
