const MOD = "wilderness-travel";

const S = {
  hexes: "hexesToday",
  day: "dayNumber",
  wild: "wildernessDays",
  log: "travelLog",
  lastTargets: "lastExhaustionTargets",
  hexMax: "hexesPerDay",
  wildMax: "exhaustionThreshold",
  showPlayers: "showToPlayers",
  publicChat: "publicChat",
  autoPrompt: "promptOnNewDay",
  posHex: "posHex",
  posWild: "posWild",
  resetPos: "resetPositions"
};

const DEFAULT_POS = { hex: { left: 120, top: 70 }, wild: { left: 120, top: 175 } };
const LOG_LENGTH = 30;

const get = (key) => game.settings.get(MOD, key);
const set = (key, value) => game.settings.set(MOD, key, value);
const DialogV2 = () => foundry.applications.api.DialogV2;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const fields = foundry.data.fields;
  const rerender = () => Tracker.render();
  const reg = (key, data) => game.settings.register(MOD, key, data);

  // Hidden world state
  reg(S.hexes, { scope: "world", config: false, type: Number, default: 0, onChange: rerender });
  reg(S.day, { scope: "world", config: false, type: Number, default: 1, onChange: rerender });
  reg(S.wild, { scope: "world", config: false, type: Number, default: 0, onChange: rerender });
  reg(S.log, {
    scope: "world", config: false,
    type: new fields.ArrayField(new fields.ObjectField()),
    default: [], onChange: rerender
  });
  reg(S.lastTargets, {
    scope: "world", config: false,
    type: new fields.ArrayField(new fields.StringField()), default: []
  });

  // Visible world settings
  reg(S.hexMax, {
    name: "Hexes per day (bar length)",
    hint: "How many hexes fill the travel bar. You can still log more (forced march); the bar turns red.",
    scope: "world", config: true, type: Number, default: 4,
    range: { min: 1, max: 20, step: 1 }, onChange: rerender
  });
  reg(S.wildMax, {
    name: "Days in the wilderness before exhaustion",
    hint: "When this many days pass without resting at a safe haven, every party member gains one level of exhaustion and the counter resets to 0.",
    scope: "world", config: true, type: Number, default: 3,
    range: { min: 1, max: 14, step: 1 }, onChange: rerender
  });
  reg(S.showPlayers, {
    name: "Show trackers to players",
    hint: "Players see the bars read-only. Only the GM can change values.",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  reg(S.publicChat, {
    name: "Post end-of-day results to chat for everyone",
    hint: "If off, the end-of-day and exhaustion messages are whispered to the GM only.",
    scope: "world", config: true, type: Boolean, default: true
  });
  reg(S.autoPrompt, {
    name: "Ask automatically when the in-game day changes",
    hint: "Opens the safe haven prompt whenever world time crosses midnight (e.g. from a calendar module). Off: use the End Day button.",
    scope: "world", config: true, type: Boolean, default: false
  });

  // Per-browser widget positions
  reg(S.posHex, { scope: "client", config: false, type: new fields.ObjectField(), default: DEFAULT_POS.hex });
  reg(S.posWild, { scope: "client", config: false, type: new fields.ObjectField(), default: DEFAULT_POS.wild });
  reg(S.resetPos, {
    name: "Reset tracker positions",
    hint: "Tick and save to move both bars back to the top-left corner.",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: async (value) => {
      if (!value) return;
      await set(S.posHex, DEFAULT_POS.hex);
      await set(S.posWild, DEFAULT_POS.wild);
      await set(S.resetPos, false);
      Tracker.destroy();
      Tracker.render();
    }
  });
});

Hooks.once("ready", () => {
  Tracker.render();
  game.modules.get(MOD).api = { endDay: () => Tracker.endDay(), render: () => Tracker.render() };
});

/* Automatic prompt when the in-game day changes */
Hooks.on("updateWorldTime", (worldTime, delta) => {
  if (!game.user.isGM || !get(S.autoPrompt) || !delta) return;
  if (game.users.activeGM?.id !== game.user.id) return;
  const spd = secondsPerDay();
  const before = Math.floor((worldTime - delta) / spd);
  const after = Math.floor(worldTime / spd);
  if (after > before) Tracker.endDay({ daysPassed: after - before });
});

function secondsPerDay() {
  const d = game.time?.calendar?.days;
  const h = d?.hoursPerDay ?? 24;
  const m = d?.minutesPerHour ?? 60;
  const s = d?.secondsPerMinute ?? 60;
  return h * m * s;
}

/* -------------------------------------------- */
/*  Tracker widgets                             */
/* -------------------------------------------- */

class Tracker {
  static els = {};
  static #prompting = false;

  static destroy() {
    for (const el of Object.values(this.els)) el.remove();
    this.els = {};
  }

  static render() {
    if (!game.ready) return;
    const visible = game.user.isGM || get(S.showPlayers);
    if (!visible) return this.destroy();
    for (const kind of ["hex", "wild"]) {
      if (!this.els[kind]) this.els[kind] = this.#create(kind);
      this.#update(kind, this.els[kind]);
    }
  }

  static #create(kind) {
    const el = document.createElement("div");
    el.className = `wt-widget wt-${kind}`;
    const pos = get(kind === "hex" ? S.posHex : S.posWild);
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    document.body.appendChild(el);
    el.addEventListener("click", (ev) => this.#onClick(ev));
    el.addEventListener("pointerdown", (ev) => this.#onDragStart(ev, kind, el));
    return el;
  }

  /* ---------- Rendering ---------- */

  static #update(kind, el) {
    const gm = game.user.isGM;
    const openLog = el.querySelector(".wt-log")?.classList.contains("open");

    if (kind === "hex") {
      const hexes = get(S.hexes);
      const max = get(S.hexMax);
      const day = get(S.day);
      const pct = Math.min(hexes / max, 1) * 100;
      const over = hexes > max;
      const ticks = Array.from({ length: max - 1 }, (_, i) =>
        `<span class="wt-tick" style="left:${((i + 1) / max) * 100}%"></span>`).join("");
      const log = get(S.log).slice().reverse().map((e) =>
        `<li><b>Day ${e.day}:</b> ${e.hexes} ${e.hexes === 1 ? "hex" : "hexes"}`
        + ` · ${e.safeHaven ? "safe haven" : "camped in the wild"}`
        + `${e.exhaustion ? " · <span class=\"wt-bad\">exhaustion</span>" : ""}</li>`).join("")
        || "<li class=\"wt-muted\">No days logged yet.</li>";

      el.innerHTML = `
        <header class="wt-handle" data-tooltip="Drag to move">
          <i class="fa-solid fa-person-hiking"></i>
          <span class="wt-title">Travel — Day ${day}</span>
          <a data-action="toggle-log" data-tooltip="Travel log"><i class="fa-solid fa-scroll"></i></a>
        </header>
        <div class="wt-bar ${over ? "wt-over" : ""}">
          <div class="wt-fill" style="width:${pct}%"></div>${ticks}
          <span class="wt-label">${hexes} / ${max} hexes today</span>
        </div>
        ${gm ? `<div class="wt-controls">
          <button data-action="hex-dec" data-tooltip="One hex less"><i class="fa-solid fa-minus"></i></button>
          <button data-action="hex-inc" data-tooltip="One hex more"><i class="fa-solid fa-plus"></i></button>
          <button data-action="edit" data-tooltip="Set values"><i class="fa-solid fa-pen"></i></button>
          <button data-action="end-day" class="wt-wide"><i class="fa-solid fa-moon"></i> End Day</button>
        </div>` : ""}
        <div class="wt-log ${openLog ? "open" : ""}">
          <ul>${log}</ul>
          ${gm ? `<button data-action="clear-log" class="wt-small"><i class="fa-solid fa-trash"></i> Clear log</button>` : ""}
        </div>`;
    }

    else {
      const days = get(S.wild);
      const max = get(S.wildMax);
      const segs = Array.from({ length: max }, (_, i) =>
        `<span class="wt-seg ${i < days ? "on" : ""} ${i === max - 1 ? "last" : ""}"></span>`).join("");
      const left = max - days;
      el.innerHTML = `
        <header class="wt-handle" data-tooltip="Drag to move">
          <i class="fa-solid fa-tree"></i>
          <span class="wt-title">Days in the wilderness</span>
        </header>
        <div class="wt-segments">${segs}</div>
        <div class="wt-sub">${days} / ${max} — exhaustion ${left <= 1 ? "<b class=\"wt-bad\">after tonight</b>" : `in ${left} nights`}</div>
        ${gm ? `<div class="wt-controls">
          <button data-action="wild-dec" data-tooltip="One day less"><i class="fa-solid fa-minus"></i></button>
          <button data-action="wild-inc" data-tooltip="One day more"><i class="fa-solid fa-plus"></i></button>
          <button data-action="wild-reset" class="wt-wide" data-tooltip="Party reached a safe haven"><i class="fa-solid fa-house"></i> Reset</button>
        </div>` : ""}`;
    }
  }

  /* ---------- Buttons ---------- */

  static async #onClick(ev) {
    const target = ev.target.closest("[data-action]");
    if (!target) return;
    ev.preventDefault();
    const action = target.dataset.action;

    if (action === "toggle-log") {
      this.els.hex?.querySelector(".wt-log")?.classList.toggle("open");
      return;
    }
    if (!game.user.isGM) return;

    switch (action) {
      case "hex-inc": return set(S.hexes, get(S.hexes) + 1);
      case "hex-dec": return set(S.hexes, Math.max(0, get(S.hexes) - 1));
      case "wild-dec": return set(S.wild, Math.max(0, get(S.wild) - 1));
      case "wild-reset": return set(S.wild, 0);
      case "wild-inc": return this.#manualWildInc();
      case "edit": return this.#editDialog();
      case "end-day": return this.endDay();
      case "clear-log": {
        const ok = await DialogV2().confirm({
          window: { title: "Clear travel log" },
          content: "<p>Delete all logged days?</p>", rejectClose: false
        });
        if (ok) return set(S.log, []);
      }
    }
  }

  static async #manualWildInc() {
    const max = get(S.wildMax);
    const next = get(S.wild) + 1;
    if (next < max) return set(S.wild, next);
    const ok = await DialogV2().confirm({
      window: { title: "Exhaustion" },
      content: `<p>This reaches ${max} days in the wilderness. Apply one level of exhaustion to the party now and reset the counter to 0?</p>`,
      rejectClose: false
    });
    if (!ok) return;
    const result = await applyExhaustion();
    await set(S.wild, 0);
    await postChat(`<h3>Wilderness exhaustion</h3>${result}`);
  }

  static async #editDialog() {
    const content = `
      <div class="form-group"><label>Current day</label>
        <input type="number" name="day" min="1" step="1" value="${get(S.day)}"></div>
      <div class="form-group"><label>Hexes travelled today</label>
        <input type="number" name="hexes" min="0" step="1" value="${get(S.hexes)}"></div>
      <div class="form-group"><label>Days in the wilderness</label>
        <input type="number" name="wild" min="0" max="${get(S.wildMax) - 1}" step="1" value="${get(S.wild)}"></div>`;
    const values = await DialogV2().wait({
      window: { title: "Wilderness Travel — set values" },
      content,
      rejectClose: false,
      buttons: [{
        action: "save", label: "Save", icon: "fa-solid fa-floppy-disk", default: true,
        callback: (event, button) => {
          const f = button.form.elements;
          return { day: f.day.valueAsNumber, hexes: f.hexes.valueAsNumber, wild: f.wild.valueAsNumber };
        }
      }, { action: "cancel", label: "Cancel" }]
    });
    if (!values || values === "cancel") return;
    const clean = (n, min, max = Infinity) => Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : min;
    await set(S.day, clean(values.day, 1));
    await set(S.hexes, clean(values.hexes, 0));
    await set(S.wild, clean(values.wild, 0, get(S.wildMax) - 1));
  }

  /* ---------- End of day ---------- */

  static async endDay({ daysPassed = 1 } = {}) {
    if (!game.user.isGM || this.#prompting) return;
    this.#prompting = true;
    try {
      const day = get(S.day);
      const hexes = get(S.hexes);
      const max = get(S.wildMax);
      const wild = get(S.wild);
      const skipped = daysPassed > 1
        ? `<p class="wt-muted">Note: ${daysPassed} days passed at once — this counts as one night. Use the + button for the others if needed.</p>` : "";

      const choice = await DialogV2().wait({
        window: { title: `End of Day ${day}`, icon: "fa-solid fa-moon" },
        content: `<p>The party travelled <b>${hexes}</b> ${hexes === 1 ? "hex" : "hexes"} today.</p>
          <p>Days in the wilderness so far: <b>${wild} / ${max}</b>.</p>
          <p><b>Did the party rest at a safe haven tonight?</b></p>${skipped}`,
        rejectClose: false,
        buttons: [
          { action: "yes", label: "Yes — safe haven", icon: "fa-solid fa-house" },
          { action: "no", label: "No — still in the wild", icon: "fa-solid fa-tree", default: true }
        ]
      });
      if (choice !== "yes" && choice !== "no") return;

      const safeHaven = choice === "yes";
      let newWild = safeHaven ? 0 : wild + 1;
      let exhaustionText = "";
      if (newWild >= max) {
        exhaustionText = await applyExhaustion();
        newWild = 0;
      }

      const log = get(S.log).concat({ day, hexes, safeHaven, exhaustion: !!exhaustionText }).slice(-LOG_LENGTH);
      await set(S.log, log);
      await set(S.wild, newWild);
      await set(S.hexes, 0);
      await set(S.day, day + 1);

      await postChat(`<h3>End of Day ${day}</h3>
        <p>Travelled ${hexes} ${hexes === 1 ? "hex" : "hexes"}.
        ${safeHaven ? "The party rested at a safe haven; the wilderness counter resets."
          : `Another night in the wild (${exhaustionText ? max : newWild} / ${max}).`}</p>
        ${exhaustionText}`);
    } finally {
      this.#prompting = false;
    }
  }

  /* ---------- Dragging ---------- */

  static #onDragStart(ev, kind, el) {
    if (!ev.target.closest(".wt-handle") || ev.target.closest("[data-action]") || ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX - el.offsetLeft;
    const startY = ev.clientY - el.offsetTop;
    el.classList.add("wt-dragging");

    const move = (e) => {
      const left = Math.min(Math.max(e.clientX - startX, 0), window.innerWidth - el.offsetWidth);
      const top = Math.min(Math.max(e.clientY - startY, 0), window.innerHeight - el.offsetHeight);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.classList.remove("wt-dragging");
      set(kind === "hex" ? S.posHex : S.posWild, { left: el.offsetLeft, top: el.offsetTop });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}

/* -------------------------------------------- */
/*  Exhaustion & chat                           */
/* -------------------------------------------- */

function partyActors() {
  // Prefer the dnd5e Primary Party group, if one is set
  let party;
  try { party = game.settings.get("dnd5e", "primaryParty")?.actor; } catch (e) { party = null; }
  const members = party?.system?.members;
  if (members?.length) {
    const actors = members.map((m) => m.actor ?? m).filter((a) => a instanceof Actor && a.type === "character");
    if (actors.length) return actors;
  }
  // Fallback: all player-owned characters
  return game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
}

/** Every actor owned by at least one player that can have exhaustion (no groups/vehicles). */
function playerOwnedActors() {
  return game.actors
    .filter((a) => a.hasPlayerOwner && a.system?.attributes?.exhaustion !== undefined)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "character" ? -1 : 1));
}

function ownerNames(actor) {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  return game.users.filter((u) => !u.isGM && actor.testUserPermission(u, OWNER)).map((u) => u.name).join(", ");
}

/** GM picks who gains exhaustion. Returns an array of actors, or null if skipped. */
async function chooseExhaustionTargets() {
  const candidates = playerOwnedActors();
  if (!candidates.length) return [];

  const last = get(S.lastTargets);
  const defaults = new Set(last?.length
    ? last.filter((id) => game.actors.has(id))
    : partyActors().map((a) => a.id));

  const rows = candidates.map((a) => {
    const lvl = Number(a.system.attributes.exhaustion ?? 0);
    const owners = ownerNames(a);
    return `<label class="wt-pick">
      <input type="checkbox" name="target" value="${a.id}" ${defaults.has(a.id) ? "checked" : ""}>
      <img src="${a.img}" alt="">
      <span class="wt-pick-name">${a.name}${owners ? `<small>${owners}</small>` : ""}</span>
      <span class="wt-pick-lvl" data-tooltip="Current exhaustion">${lvl}</span>
    </label>`;
  }).join("");

  const ids = await DialogV2().wait({
    window: { title: "Exhaustion — who is affected?", icon: "fa-solid fa-bed" },
    position: { width: 380 },
    content: `<p>${get(S.wildMax)} days in the wilderness. Tick everyone who gains one level of exhaustion:</p>
      <div class="wt-pick-actions">
        <a data-pick="all">Select all</a> · <a data-pick="none">Select none</a>
      </div>
      <div class="wt-pick-list">${rows}</div>`,
    rejectClose: false,
    render: (event, dialog) => {
      const root = dialog.element ?? event?.target?.element;
      root?.querySelectorAll("[data-pick]").forEach((link) => link.addEventListener("click", (ev) => {
        ev.preventDefault();
        const on = link.dataset.pick === "all";
        root.querySelectorAll("input[name=target]").forEach((cb) => { cb.checked = on; });
      }));
    },
    buttons: [{
      action: "apply", label: "Apply exhaustion", icon: "fa-solid fa-check", default: true,
      callback: (event, button) => [...button.form.querySelectorAll("input[name=target]:checked")].map((cb) => cb.value)
    }, { action: "skip", label: "Skip (apply nothing)", icon: "fa-solid fa-xmark" }]
  });

  if (!Array.isArray(ids)) return null;
  await set(S.lastTargets, ids);
  return ids.map((id) => game.actors.get(id)).filter(Boolean);
}

async function applyExhaustion() {
  const actors = await chooseExhaustionTargets();
  if (actors === null) {
    return `<p><b>${get(S.wildMax)} days in the wilderness — exhaustion was due,</b> but the GM skipped applying it.</p>`;
  }
  if (!actors.length) {
    ui.notifications.warn("Wilderness Travel: nobody selected — exhaustion not applied.");
    return `<p><b>${get(S.wildMax)} days in the wilderness — exhaustion was due,</b> but nobody was selected.</p>`;
  }
  const maxLevel = CONFIG.DND5E?.conditionTypes?.exhaustion?.levels ?? 6;
  const lines = [];
  for (const actor of actors) {
    const current = Number(actor.system.attributes?.exhaustion ?? 0);
    const next = Math.min(current + 1, maxLevel);
    await actor.update({ "system.attributes.exhaustion": next });
    const warn = next >= maxLevel ? " <span class=\"wt-bad\">(maximum!)</span>" : "";
    lines.push(`<li>${actor.name}: level ${current} → <b>${next}</b>${warn}</li>`);
  }
  return `<p><b>${get(S.wildMax)} days in the wilderness — one level of exhaustion for:</b></p><ul>${lines.join("")}</ul>`;
}

async function postChat(content) {
  const data = { content: `<div class="wt-chat">${content}</div>`, speaker: { alias: "Wilderness Travel" } };
  if (!get(S.publicChat)) data.whisper = ChatMessage.getWhisperRecipients("GM");
  return ChatMessage.create(data);
}
