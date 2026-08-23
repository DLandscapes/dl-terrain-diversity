/**
 * The sidebar's collapsible sections — memory, badges and auto-open.
 *
 * The collapse itself is native <details> and needs none of this file; what a
 * <details> cannot do on its own is remember its state, say what is live
 * inside it while closed, or open when the tool enters a mode whose controls
 * it holds. Those three, and nothing else, live here.
 *
 * ⚠️ DOM-ONLY, ON PURPOSE. The badges read the same controls the user sees —
 * the `on` class the toggles already carry, the rows the region list already
 * draws — so a badge cannot disagree with the interface it summarises.
 * Importing app state here would make this file a second reader of that state
 * to keep in step, and app.js does not know this file exists, which is what
 * keeps the render suite (which loads the modules, never the sidebar) and any
 * future embedding indifferent to it.
 */

const KEY = "dl-terraindiversity.sections";
// "substrate" is the nested sub-fold inside Site; same persistence, no badge.
// Nested sub-folds (substrate, ortho, photos, rain, species, where, bench,
// guide) persist with the top-level sections; only the top-level ones carry
// badges.
// ⚠️ EVERY SUB-FOLD BELONGS IN THIS LIST. `where`, `bench` and `guide` were
// missing, so those three alone forgot their state on reload while their
// neighbours remembered — which reads as the menu rearranging itself.
const SECTIONS = ["site", "substrate", "ortho", "photos", "section", "shape",
  // ⚠️ `brush` JOINED THE LIST WHEN IT BECAME A FOLD (2026-08-13). A sub-fold
  // missing from here forgets its state on reload while its neighbours
  // remember, which reads as the menu rearranging itself — the exact bug this
  // list's own note records for `where`, `bench` and `guide`.
  "where", "brush", "bench", "guide", "stamp", "read", "rain", "species",
  // Selection's three sources, added 2026-08-13 with the same warning as above.
  "sel-draw", "sel-import", "sel-rule",
  // ⚠️ 2026-08-16, and the third time this note has had to be written: Import's
  // `terrain` fold and View's two representation folds. `terrain` matters most
  // — it holds the drop target, so forgetting it would reopen the tallest block
  // in the panel on every reload.
  "terrain", "view-surface", "view-voxels", "view-layer",
  // ⚠️ 2026-08-20, and the FOURTH time: Display's glyph fold. Adding a
  // <details class="sub"> without adding it here is a bug that only shows on
  // the next reload, which is why it keeps being missed.
  "view-glyphs",
  "measured", "view", "export"];

/**
 * The eight named panels, which are the ones that carry badges — and, since
 * 2026-08-12, the ones that behave as an accordion.
 *
 * ⚠️ ONE PANEL AT A TIME, AND THE BADGES ARE WHY IT IS SAFE. With Site, Section,
 * Shape and Read all open the column measured 2 715 px in a 696 px window —
 * four times the height of the thing it is drawn in, and the Phase 8C
 * sub-folding fix bought back only part of it because the cost is not in the
 * sub-folds. It is in two blocks that must stay open when their panel is: the
 * 743 px analysis grid in Read, and the 184 px drop target in Site.
 *
 * Sub-folding cannot reach either, because both are the point of the panel they
 * are in. Closing the OTHER panels can, and it costs nothing, because the header
 * badges were built in Phase 8C precisely so a folded section still reports what
 * is live inside it. The column is now bounded by its tallest single panel
 * rather than by their sum.
 */
// ⚠️ IN DOM ORDER. The boot rule below keeps the FIRST open panel and closes
// the rest, so this list deciding a different order from the markup would open
// a panel the reader has not reached yet.
// "where" became a top-level panel on 2026-08-13 (Selection, between Site and
// the modifiers — SELECT → MODIFY → READ is the tool's grammar); its
// persistence key is unchanged, so stored fold state survives the promotion.
// ⚠️ THE LEFT IS THE SIX INPUT STEPS, IN THE ORDER THE WORK HAPPENS (Marc's
// rule, 2026-08-13): import → make visible → select → modify → cut sections →
// export. `read` and `measured` are NOT here any more: they are readings, and
// readings live in the readout window on the right.
const PANELS = ["site", "view", "where", "shape", "section", "export", "method"];
/** The readout window's own panels — four peers, each toggling alone. */
const RPANELS = ["numbers", "layers", "rain", "species"];
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ memory */

// The markup's own `open` attributes are the shipped first-boot state, chosen
// pedagogically (Site, Shape, Read). Stored state only ever OVERLAYS it, so a
// first visit — or a cleared browser — always lands on the taught arrangement.
try {
  const stored = JSON.parse(localStorage.getItem(KEY) || "null");
  if (stored) {
    // ⚠️ ONE-TIME MIGRATION, AND IT EXISTS BECAUSE STORED STATE OUTLIVES A BUG.
    // `terrain` shipped collapsed for one session, so every browser that opened
    // the tool in that window has `terrain: false` written down. Changing the
    // markup alone would therefore fix the defect for new installs and leave it
    // in place for exactly the people who hit it. The marker makes the
    // correction run once and never fight the user's own later choice.
    // ⚠️ ONE VERSIONED MARKER, NOT ONE KEY PER FIX. Stored fold state outlives
    // every layout decision, so each change to the shipped arrangement needs a
    // way to reach browsers that already wrote the old one down — and a
    // per-fix key would accumulate forever.
    // ⚠️ SET THE VALUES, DO NOT MERELY DELETE THEM. Deleting a key and trusting
    // the markup to win is one cache revalidation away from doing nothing: the
    // stored value is authoritative here and the markup is not reachable from
    // this file. That is exactly how the `terrain` fix failed its first test.
    const MIGRATION = `${KEY}.layout`;
    const at = Number(localStorage.getItem(MIGRATION) || 0);
    if (at < 1) {
      stored.terrain = true;    // Import opened on four folded headers
      localStorage.setItem(MIGRATION, "1");
    }
    for (const s of SECTIONS) {
      // ⚠️ TOP-LEVEL PANELS DO NOT RESTORE (Marc, 2026-08-19): the tool opens
      // with NONE of them expanded, every time. A one-time reset was not what
      // was asked for — it would collapse the menu once and then reopen
      // whatever you happened to leave open, so the second launch of the day
      // looks nothing like the first. The titled rail is what you land on, and
      // it is the whole menu until you choose. Sub-folds still persist: those
      // are settings inside a panel, and forgetting them is the bug this
      // list's own note records three times over.
      if (PANELS.includes(s)) continue;
      const el = $(`sec-${s}`);
      if (el && typeof stored[s] === "boolean") el.open = stored[s];
    }
  }
} catch { /* storage unavailable: the accordion still collapses, just forgets */ }

// ⚠️ THE INVARIANT HAS TO HOLD AT BOOT, NOT ONLY ON A CLICK. The markup ships
// Site, Section, Shape and Read open together — the pedagogical arrangement
// from before the accordion — and stored state from an earlier version can say
// the same. Nothing has been toggled yet at this point, so the listener below
// has not run and would not run until the user pressed something. Left alone
// the tool would open four panels deep exactly once per install, which is the
// state this change exists to prevent.
{
  let kept = false;
  for (const s of PANELS) {
    const el = /** @type {HTMLDetailsElement} */ ($(`sec-${s}`));
    if (!el || !el.open) continue;
    if (kept) el.open = false; else kept = true;
  }
}

function persist() {
  const out = {};
  for (const s of SECTIONS) {
    // Not the top-level panels — see the restore note. Writing a value nothing
    // reads back is how a stored blob starts lying about what it controls.
    if (PANELS.includes(s)) continue;
    const el = $(`sec-${s}`);
    if (el) out[s] = el.open;
  }
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* as above */ }
}
/** The menu's geometry changed — folded, moved, or a section grew/shrank.
 *  Announced as one event; app.js re-flows the readout around it. */
const announce = () => document.dispatchEvent(new CustomEvent("dl-menu-layout"));
for (const s of SECTIONS) {
  $(`sec-${s}`)?.addEventListener("toggle", () => { persist(); announce(); });
}

/**
 * Put the panels in the order the work happens.
 *
 * ⚠️ DOM ORDER IS NOW VISIBLE ORDER, AND IT WAS WRONG. While the rail existed
 * the panels' position in the markup did not matter — the rail imposed its own
 * order and the open panel was the only one drawn. With the headers merged into
 * the panels (2026-08-19) the six rows ARE the menu, so the markup order is
 * what a reader sees, and `View` sat fifth: import → select → modify → sections
 * → VIEW → export. The rule this project has held since 2026-08-13 is
 * import → make visible → select → modify → cut sections → export.
 *
 * ⚠️ MOVED AT RUNTIME, NOT IN THE MARKUP — the same decision, and the same
 * reason, as the readout panels a few lines below: `appendChild` relocates a
 * node with every listener, id and piece of live state intact, it is trivially
 * reversible, and it cannot damage its neighbours the way a scripted structural
 * edit on index.html once ate the export block.
 */
{
  const body = $("menu-body");
  if (body) {
    for (const s of PANELS) {
      const el = $(`sec-${s}`);
      // `method` is in PANELS but has no panel in the markup; skip rather than
      // assume, so the list and the document can disagree without throwing.
      if (el && el.parentElement === body) body.appendChild(el);
    }
  }
}

/* --------------------------------------------------------------- accordion */

/**
 * Opening a panel closes the others. See the note on PANELS for why this is the
 * fix and sub-folding is not.
 *
 * ⚠️ GUARDED AGAINST ITS OWN CASCADE. Closing a sibling fires that sibling's
 * own `toggle`, which lands back here; without the flag the first open would
 * walk the whole list re-entrantly, persisting and announcing once per panel.
 * The guard also means the cascade persists ONCE, at the end, which is the
 * state the user actually chose.
 */
let cascading = false;
for (const s of PANELS) {
  $(`sec-${s}`)?.addEventListener("toggle", () => {
    const el = /** @type {HTMLDetailsElement} */ ($(`sec-${s}`));
    if (!el || !el.open || cascading) return;
    cascading = true;
    for (const other of PANELS) {
      if (other === s) continue;
      const o = /** @type {HTMLDetailsElement} */ ($(`sec-${other}`));
      if (o && o.open) o.open = false;
    }
    cascading = false;
    persist();
    announce();
  });
}

/* ------------------------------------------------------- the readout window */

/**
 * Move the two READING panels out of the menu and into the readout window.
 *
 * ⚠️ MOVED, NOT COPIED, AND THAT IS THE WHOLE POINT. `appendChild` relocates a
 * node with every listener, id, dataset and piece of live state intact — so
 * app.js's analysis grid, its click and hover handlers, the ramp stretch
 * handles and the Measured rows all keep working without one line of
 * re-binding. Rebuilding this markup on the right instead would have meant
 * re-wiring the busiest panel in the tool, and duplicating it would have
 * recreated the two-copies-of-one-number trap Phase 8C already paid for.
 *
 * ⚠️ AND IT IS DONE IN JS RATHER THAN IN THE MARKUP because a scripted
 * structural edit on index.html is exactly what ate the export block in Phase
 * 8D. A six-line move at boot is reversible, cannot damage its neighbours, and
 * keeps the layout easy to change while Marc is still iterating on it.
 */
{
  const move = (fromId, intoId) => {
    const from = $(fromId), into = $(intoId);
    if (!from || !into) return;
    const body = from.querySelector(":scope > .sec-body");
    if (!body) return;
    // The panel's own children, not the <details> wrapper — the readout
    // supplies its own heading and fold.
    while (body.firstChild) into.appendChild(body.firstChild);
    from.remove();          // the now-empty left panel goes with it
  };
  move("sec-measured", "numbers-body");
  move("sec-read", "layers-body");

  // ⚠️⚠️ THE LEDGER IS A READING, AND IT WAS ON THE WRONG SIDE. "Net earth
  // moved", with its cut and fill, sat inside the Modify panel on the left —
  // so the single most important figure the tool produces was visible only
  // while that one panel happened to be open, and invisible the moment you
  // switched to Selection or Sections. It is also the number watched WHILE
  // working, which is the whole argument for the Measured panel. Moved to the
  // TOP of it, above the terrain statistics, because it is the headline.
  // (It used to be relocated into an instrument dock by setInstrument; that
  // dock went with the one-mode change in Phase 8C and nothing claims the
  // element now, so this move is unopposed.)
  const led = $("ledger"), num = $("numbers-body");
  if (led && num) num.insertBefore(led, num.firstChild);

  // ⚠️ THE LAYER SELECTOR GOES LEFT, THE RAMP STAYS RIGHT (Marc, 2026-08-20),
  // and the split is the point rather than a compromise.
  //
  // DESIGN-interface-left-right.md names this exact case as the rule's one hard
  // edge: "a control that governs a reading is not an input to the design …
  // The colour-ramp handles do not change the terrain — they change how a
  // measurement is displayed", and puts those on the RIGHT. That is still true
  // of the ramp, the stretch handles and the solar note, and they do not move.
  //
  // But CHOOSING WHICH LAYER IS DRAWN ON THE GROUND is not tuning a reading —
  // it is deciding how the centre is displayed, which is exactly what the
  // Display panel is for. Display already owns the other two decisions of that
  // kind, Surface/Voxels and the glyph field, so the shader sitting alone on
  // the far side was the inconsistency: three display choices, one of them
  // somewhere else. Marc reported it as a feeling before it was named.
  //
  // ⚠️ MOVED, NOT REBUILT — same reason as the panels above. The grid carries
  // seventeen live canvases with click and hover handlers bound in app.js;
  // appendChild keeps every one of them.
  {
    const grid = $("panels"), view = $("sec-view");
    const body = view && view.querySelector(":scope > .sec-body");
    if (grid && body) {
      const fold = document.createElement("details");
      fold.className = "sub";
      fold.id = "sec-view-layer";
      const sum = document.createElement("summary");
      sum.className = "subhead";
      // Display's subs name the THING, per the phase-11 naming rule —
      // Surface, Voxels, Attribute glyphs. So: the layer itself.
      sum.textContent = "Analysis layer";
      const inner = document.createElement("div");
      inner.className = "sec-body";
      inner.appendChild(grid);
      fold.append(sum, inner);
      // First, because what is drawn on the ground is the first display
      // decision — the representation and the glyphs modify what it shows.
      body.insertBefore(fold, body.firstChild);
    }
  }
}

// ⚠️ RAINFALL AND SPECIES STAND ON THEIR OWN (Marc, 2026-08-13). They arrive
// inside Read's body with the analysis grid; each becomes a top-level panel of
// the readout with its own rail icon, so either can be turned on alone. With
// both of them promoted, "Response" had nothing left in it and the category
// was removed rather than kept as an empty drawer.
// ⚠️ THE CLASS CHANGES WITH THE PLACE: `sub` styles a nested fold inside a
// panel, `rpanel` a top-level one. Left as `sub` they would draw the indented
// spine of something nested inside a parent that no longer exists.
{
  const body = $("readout-body");
  for (const id of ["sec-rain", "sec-species"]) {
    const el = $(id);
    if (!el || !body) continue;
    el.classList.remove("sub");
    el.classList.add("rpanel");
    body.appendChild(el);
  }
}

/* ---------------------------------------------------------------- the rail */

/**
 * The tab rail: eight always-visible marks, the current one filled.
 *
 * ⚠️ A SECOND CONTROL FOR STATE THAT ALREADY EXISTED, not a replacement. The
 * accordion above already guarantees one open panel; app.js opens panels by
 * hand (`sec-guide` when the Guide tool is armed). So the rail only ever sets
 * `open` and then READS it back — which means a panel opened from anywhere
 * lights its own tab, and persistence, badges and auto-open keep working
 * without knowing the rail exists.
 *
 * ⚠️ CLICKING THE CURRENT TAB DOES NOT CLOSE IT. A rail with nothing selected
 * is a menu showing no controls at all, which reads as the tool having
 * emptied itself — and the accordion's own invariant is "one open", not "at
 * most one".
 */
const rail = $("tab-rail");
rail?.addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("button");
  if (!b || !b.dataset.panel) return;
  const el = /** @type {HTMLDetailsElement} */ ($(`sec-${b.dataset.panel}`));
  if (el && !el.open) el.open = true;    // fires 'toggle': the accordion closes the rest
  syncRail();
});

function syncRail() {
  if (!rail) return;
  for (const b of rail.querySelectorAll("button")) {
    const key = /** @type {HTMLElement} */ (b).dataset.panel;
    const el = /** @type {HTMLDetailsElement} */ ($(`sec-${key}`));
    b.classList.toggle("on", !!el && el.open);
  }
}
// The rail follows the panels however they were opened — including from code.
for (const s of PANELS) $(`sec-${s}`)?.addEventListener("toggle", syncRail);

/* ------------------------------------------------- the readout's own rail */

/**
 * The readout window's rail and accordion.
 *
 * ⚠️ NOT AN ACCORDION, AND NOT THE LEFT ONE (Marc, 2026-08-13). The left rail's
 * rule is "one panel at a time", and it must not reach across: opening Layers
 * on the right has no business closing Modify on the left.
 *
 * The right rail's rule is different in kind — **each icon toggles its own
 * panel, alone**. These are readings, and a designer legitimately wants two of
 * them at once: the figures WITH the layer being judged, or rainfall WITH the
 * species it feeds. One-at-a-time would make every comparison a click apart.
 *
 * ⚠️ AND NOTHING IS EXEMPT ANY MORE. `numbers` used to be pinned open on the
 * argument that it is watched while working — true, but it made one icon
 * behave unlike its three neighbours, and an inconsistent control is a worse
 * problem than the one it solved. Anything can be turned off; what protects
 * the ledger now is that it opens by default and is the first thing in it.
 */
const rrail = $("readout-rail");
function syncRRail() {
  if (!rrail) return;
  for (const b of rrail.querySelectorAll("button")) {
    const key = /** @type {HTMLElement} */ (b).dataset.rpanel;
    const el = /** @type {HTMLDetailsElement} */ ($(`sec-${key}`));
    b.classList.toggle("on", !!el && el.open);
  }
}
rrail?.addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("button");
  if (!b || !b.dataset.rpanel) return;
  const el = /** @type {HTMLDetailsElement} */ ($(`sec-${b.dataset.rpanel}`));
  if (!el) return;
  el.open = !el.open;
  syncRRail();
});
for (const s of RPANELS) $(`sec-${s}`)?.addEventListener("toggle", syncRRail);
syncRRail();

/* ------------------------------------------------------- the readout's drag */
// ⚠️ IT HAS NO FOLD OF ITS OWN — `setFolded` below takes both windows, so the
// one control in the corner clears the whole interface in a single press. It
// only drags.
{
  const win = $("readout");
  const head = $("readout-head");
  let drag = null;
  head?.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#readout-min")) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    win.classList.add("dragging");
    try { head.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  });
  head?.addEventListener("pointermove", (e) => {
    if (!drag) return;
    // ⚠️ Positioned from the RIGHT edge, so it stays put when the window is
    // resized — the same reason the menu is positioned from the left.
    const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    win.style.left = `${x}px`;
    win.style.right = "auto";
    win.style.top = `${y}px`;
  });
  const endDrag = () => { drag = null; win?.classList.remove("dragging"); };
  head?.addEventListener("pointerup", endDrag);
  head?.addEventListener("pointercancel", endDrag);
}

/* ------------------------------------------------------------------ badges */

const on = (id) => !!$(id)?.classList.contains("on");
const shown = (id) => { const el = $(id); return !!el && !el.hidden; };
const rows = (id) => ($(id) ? $(id).children.length : 0);

/** The armed brush, by reading the palette the way the eye does. */
function armedTool() {
  for (const [id, name] of [["t-level", "level armed"], ["t-smooth", "smooth armed"],
    ["t-scoop", "scoop armed"], ["t-mound", "mound armed"]]) {
    if (on(id)) return name;
  }
  return "";
}

/**
 * What each CLOSED section would be hiding. CSS hides the badge while the
 * section is open, so this only ever surfaces state whose controls are folded
 * away — an armed brush that still paints on the next drag, rain still
 * standing on the surface, an instrument overlay somebody will record through.
 */
function badgeText(sec) {
  const parts = [];
  switch (sec) {
    case "site":
      if (on("t-soil")) parts.push("paint armed");
      break;
    case "where": {
      // The selection's live state: an armed drawing tool, the regions that
      // exist, and a rule still narrowing every modifier while folded away.
      for (const [id, name] of [["pt-draw", "draw armed"],
        ["pt-hole", "hole armed"], ["pt-edit", "select armed"]]) {
        if (on(id)) parts.push(name);
      }
      const r = rows("plan-list");
      if (r) parts.push(`${r} region${r > 1 ? "s" : ""}`);
      if (on("t-rule")) parts.push("rule on");
      break;
    }
    case "shape": {
      const t = armedTool();
      if (t) parts.push(t);
      if (on("pt-guide")) parts.push("guide armed");
      break;
    }
    case "section": {
      // The sections moved to their own top-level group, and so did their
      // badge — an armed cut is live state a folded group must still declare.
      if (on("pt-section")) parts.push("cutting");
      const s = rows("section-list");
      if (s) parts.push(`${s} section${s > 1 ? "s" : ""}`);
      break;
    }
    case "read": {
      const active = document.querySelector("#panels .raster.active span");
      if (active) parts.push(active.textContent.trim());
      if (on("t-water")) parts.push("rain");
      break;
    }
    case "measured": {
      // The scoreboard's headline survives the fold: H′, habitats, invasive.
      // Read from the same cells the open panel shows, so the folded and the
      // open reading can never disagree.
      const shannon = ($("m-shannon")?.textContent || "").split(" /")[0].trim();
      const rich = ($("m-richness")?.textContent || "").replace(/\s+/g, "");
      const inv = ($("m-invasive")?.textContent || "").trim();
      if (shannon && shannon !== "—") {
        parts.push(`H′ ${shannon}`);
        if (rich && rich !== "—") parts.push(rich);
        if (inv && inv !== "—") parts.push(`inv ${inv}`);
      }
      break;
    }
    case "view":
      if (on("r-voxel")) parts.push("voxels");
      if (on("t-plants")) parts.push("vegetation");
      if (on("t-context")) parts.push("context");
      if (on("t-contours")) parts.push("contours");
      if (on("t-hud")) parts.push("instrument");
      break;
    default:
      break;
  }
  return parts.join(" · ");
}

/**
 * Whether a tab deserves its dot — which is NOT the same question as whether
 * it has anything to report.
 *
 * ⚠️ THE DOT WAS ON PERMANENTLY FOR HALF THE RAIL (2026-08-13, Marc: "why is
 * there a dot inside the view-, select- and modify icons?"). It was derived
 * from the badge TEXT, and that text lists everything live in a panel — but a
 * brush is ALWAYS armed and contours are ON by default, so Modify and View
 * carried a dot from boot and never lost it. An indicator that is always lit
 * says nothing; worse, it teaches the eye to ignore the one case that matters.
 *
 * The dot now means: **something is armed or running here that you could
 * forget about, and that would surprise you later.** A rule silently narrows
 * every modifier; a trace or cut mode swallows the next click; the overlay
 * changes what a recording shows; substrate paint edits on drag. A default is
 * not news. The tooltip keeps the full text either way, so nothing is lost —
 * only the alarm is made honest.
 * @param {string} sec
 */
function badgeAlert(sec) {
  switch (sec) {
    case "site": return on("t-soil");          // paint edits on the next drag
    case "where": return on("t-rule");         // narrows every modifier, silently
    case "shape": return on("pt-guide");       // a trace mode owns the next click
    case "section": return on("pt-section");   // …and so does a cut
    case "view": return on("t-hud");           // the overlay is in the recording
    default: return false;
  }
}

/* --------------------------------------------------------------- auto-open */

// Rising edges only, so opening never fights a user who closes the section
// afterwards: a section opens when its mode STARTS, and a closed section with
// the mode already running stays closed until the mode starts again.
//
// ⚠️ EACH EDGE NAMES THE PANEL IT OPENS (2026-08-13). All three used to open
// Shape — right when everything lived there, and quietly wrong since the
// sections moved out: cutting the first section opened Shape while the
// section's own panel stayed shut. A drawing tool arming opens Selection;
// regions appearing (an import too) opens Selection; the first section cut
// opens Section. The guide is deliberately absent: its button lives inside
// the panel it would open.
const edges = {
  "draw-tools": { test: () => on("pt-draw") || on("pt-hole") || on("pt-edit"),
    panel: "where" },
  "plan-select": { test: () => shown("plan-select"), panel: "where" },
  "section-tools": { test: () => shown("section-tools"), panel: "section" },
};
const prev = {};
for (const k of Object.keys(edges)) prev[k] = edges[k].test();

function autoOpen() {
  for (const k of Object.keys(edges)) {
    const now = edges[k].test();
    if (now && !prev[k]) {
      const el = $(`sec-${edges[k].panel}`);
      if (el && !el.open) el.open = true;   // fires 'toggle', which persists
    }
    prev[k] = now;
  }
}

/* ------------------------------------------------------------------- sync */

function sync() {
  autoOpen();
  for (const s of SECTIONS) {
    const el = $(`b-${s}`);
    if (!el) continue;
    const text = badgeText(s);
    // Only write on change: an unchanged badge fires no mutation, which is
    // what lets the observer below watch the whole sidebar without feeding
    // itself.
    if (el.textContent !== text) el.textContent = text;
    // ⚠️ AND ONTO THE SECTION'S OWN ROW (2026-08-19, when the rail merged into
    // the panel headers). Live state inside a panel you are not looking at must
    // still be announced — an armed brush that paints on the next drag, rain
    // still standing. The dot carries the fact; the badge beside the title
    // carries the detail while the panel is closed.
    const panel = $(`sec-${s}`);
    if (panel) {
      panel.classList.toggle("live", badgeAlert(s));
      const sum = panel.querySelector(":scope > summary");
      const h2 = sum && sum.querySelector(":scope > h2");
      const name = h2 ? (h2.textContent || s) : s;
      const want = text ? `${name} · ${text}` : name;
      if (sum && sum.title !== want) sum.title = want;
    }
  }
}

/* ------------------------------------------------- the floating window --- */
// One mode (2026-08-11): the menu floats over the viewport. It drags by its
// header, folds to the Menu chip for a clean recording frame, and remembers
// both. The HUD is told about folds through a DOM event rather than a call —
// app.js listens, this file stays ignorant of the readout's existence.

const PANEL_KEY = "dl-terraindiversity.panel";
const panel = $("sidebar");
const chip = $("menu-chip");

function panelState() {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY) || "null") || {}; }
  catch { return {}; }
}
function persistPanel(patch) {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify({ ...panelState(), ...patch })); }
  catch { /* storage unavailable: the window still floats, just forgets */ }
}
/** Keep the header reachable whatever the stored position or window size. */
function clampPanel(x, y) {
  return [
    Math.max(0, Math.min(window.innerWidth - 80, x)),
    Math.max(0, Math.min(window.innerHeight - 40, y)),
  ];
}

/**
 * The chip's own clamp.
 *
 * ⚠️ NOT clampPanel's. That one reserves 80 px so a 330 px window keeps a
 * grabbable corner on screen; applied to a 26 px chip it drags the chip 32 px
 * left of the − button it is supposed to replace — which is exactly the
 * misalignment this pairing exists to remove, and it only shows up in a
 * window narrow enough for the clamp to bite.
 */
function clampChip(x, y) {
  return [
    Math.max(0, Math.min(window.innerWidth - 30, x)),
    Math.max(0, Math.min(window.innerHeight - 26, y)),
  ];
}
/**
 * Fold the menu away, or bring it back.
 *
 * ⚠️ THE CHIP LANDS EXACTLY WHERE THE − BUTTON WAS (2026-08-11). They are one
 * toggle, so they must occupy one point on the screen: the chip used to sit
 * at the window's top-left corner while − sat at the menu header's right end,
 * about 300 px apart, and folding meant chasing the control across the
 * viewport to unfold again. Measured from the live button rather than
 * computed from the menu's width, so it stays correct after the window has
 * been dragged anywhere — and persisted, so a reload that restores a folded
 * menu puts the chip back in the same place rather than at a default corner.
 * @param {boolean} min
 */
function setFolded(min) {
  const b = $("menu-min");
  if (min && chip && b) {
    // ⚠️ MEASURE BEFORE HIDING, AND ONLY TRUST A REAL RECT. A hidden or
    // not-yet-laid-out element measures 0×0 at 0,0 — and the boot restore calls
    // this from an inline script that runs BEFORE the first layout, so an
    // unguarded measure parked the chip in the top-left corner of the viewport
    // and persisted it there: the precise wandering this pairing exists to
    // prevent. With no usable rect the persisted position simply stands.
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const [x, y] = clampChip(r.left, r.top);
      chip.style.left = `${x}px`;
      chip.style.top = `${y}px`;
      persistPanel({ chipX: x, chipY: y });
    }
  }
  panel.classList.toggle("min", min);
  // ⚠️ THE READOUT FOLDS WITH THE MENU (Marc, 2026-08-13). One control, one
  // press, the whole interface out of the way — which is what a clean
  // recording frame needs, and it removes the half-folded state that two
  // independent buttons allowed.
  $("readout")?.classList.toggle("min", min);
  // ⚠️⚠️ THE FOLD BUTTON HAS TO HIDE WITH THE MENU (2026-08-13). It used to sit
  // INSIDE the menu header, so `#sidebar.min { display:none }` took it away for
  // free. Moving it onto the viewport broke that silently: folded, ⊟ stayed on
  // screen stacked exactly on top of the ☰ chip, `elementFromPoint` returned
  // the button, and every click at that spot folded an already-folded menu —
  // so the menu could be dismissed and never brought back. Reported as "all
  // menu should appear again once i click on it again".
  if (b) b.hidden = min;
  if (chip) chip.hidden = !min;
  persistPanel({ min });
  announce();
}

{
  const s = panelState();
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
    const [x, y] = clampPanel(s.x, s.y);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  }
  // The chip's own remembered spot, restored BEFORE the fold below so a
  // reload that opens folded puts the toggle back under the same pixel.
  if (chip && Number.isFinite(s.chipX) && Number.isFinite(s.chipY)) {
    const [cx, cy] = clampChip(s.chipX, s.chipY);
    chip.style.left = `${cx}px`;
    chip.style.top = `${cy}px`;
  }
  if (s.min) setFolded(true);
}
$("menu-min")?.addEventListener("click", () => setFolded(true));
chip?.addEventListener("click", () => setFolded(false));

/* ------------------------------------------------------- explanatory text */

/**
 * Show or hide the explanatory prose.
 *
 * ⚠️ A MODE, NOT A HOVER, and ⚠️ IT DEFAULTS TO SHOWN. The measured cost is
 * real — 870 px of prose in a 694 px window with one panel open — but this
 * tool teaches, is used in a workshop and gets screen-recorded, and hover text
 * cannot be read on a touch screen, never lands in a recording, and cannot be
 * pointed at while talking. So the prose stays the shipped state and the
 * switch is for the user who has stopped needing it. Persisted with the rest
 * of the window's state, so the choice survives a reload.
 * @param {boolean} lean
 */
function setLean(lean) {
  panel.classList.toggle("lean", lean);
  $("explain")?.classList.toggle("on", !lean);
  persistPanel({ lean });
  announce();          // the readout re-flows around the menu's new height
}
// ⚠️ The header opens the Method popover; the DL mark inside it opens the
// website. Without this the link would do both.
$("logo-link")?.addEventListener("click", (e) => e.stopPropagation());

$("explain")?.addEventListener("click", (e) => {
  // ⚠️ The header carries data-info="method"; without this the popover opens
  // every time the prose is hidden.
  e.stopPropagation();
  setLean(!panel.classList.contains("lean"));
});
setLean(panelState().lean === true);

// Drag by the header. The buttons inside the header must stay buttons, so a
// press that starts on one never becomes a drag.
{
  const head = $("menu-head");
  let drag = null;
  head?.addEventListener("pointerdown", (e) => {
    // ⚠️ The DL mark is a link — a press on it must stay a press on a link,
    // not become the start of a window drag.
    if (e.target.closest("#menu-min, #explain, #logo-link")) return;
    drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
    panel.classList.add("dragging");
    try { head.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  });
  head?.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = clampPanel(e.clientX - drag.dx, e.clientY - drag.dy);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });
  head?.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = null;
    panel.classList.remove("dragging");
    persistPanel({ x: panel.offsetLeft, y: panel.offsetTop });
    announce();
  });
}

// One observer over the whole sidebar rather than a call site in every
// handler: the controls already change class, hidden and row count for their
// own reasons, and those mutations are the signal. The callback runs sync()
// DIRECTLY — observer callbacks arrive batched already, and deferring to
// requestAnimationFrame would stall every badge and auto-open while the tab
// is hidden, exactly the rAF trap the capture path already documents. A badge
// write re-fires the callback once; sync() is idempotent, writes only on
// change, and therefore settles on that pass.
const observer = new MutationObserver(() => sync());
observer.observe(document.getElementById("sidebar"), {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["class", "hidden"],
  // characterData: the Measured badge mirrors metric VALUES, which arrive as
  // text-node edits that childList never reports. Without this the folded
  // scoreboard freezes at whatever the numbers were when it was folded.
  characterData: true,
});
sync();
syncRail();   // the rail must show the restored panel from the first paint
