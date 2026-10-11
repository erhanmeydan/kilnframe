# Technique: ui-mockup

Product screens, app interfaces, buttons, cursors and clicks.

- Build the interface from real HTML/CSS components (cards, buttons, inputs, toggles, lists) styled with the
  style tokens; keep it simple and readable at video size (large type, few elements).
- If the user provided screenshots in the scene assets, place them inside a device or card frame instead of
  inventing a UI. Never draw real brand logos.
- A cursor (inline SVG arrow) moves on smooth curves (animate x/y with a sine ease, or along a path) and
  clicks with a small press and ripple on the word that names the action.
- Show cause and effect: click, then the interface responds (state change, panel opens, value updates).
- Screens should feel like a moment of use, not a static mockup: one interaction per scene.
