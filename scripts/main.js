const MOD = "wilderness-travel";

const S = {
  hexes: "hexesToday",
  wild: "wildernessDays",
  lastTargets: "lastExhaustionTargets",
  hexMax: "hexesPerDay",
  wildMax: "exhaustionThreshold",
  hexLabel: "hexLabel",
  wildLabel: "wildLabel",
  hexPlayers: "hexVisibleToPlayers",
  wildPlayers: "wildVisibleToPlayers",
  publicChat: "publicChat",
  posHex: "posHex",
  posWild: "posWild",
  resetPos: "resetPositions"
};

const DEFAULT_POS = { hex: { left: 120, top: 120 }, wild: { left: 120, top: 70 } };
const DRAG_THRESHOLD = 4;

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
  reg(S.wild, { scope: "world", config: false, type: Number, default: 0, onChange: rerender });
  reg(S.lastTargets, {
    scope: "world", config: false,
    type: new fields.ArrayField(new fields.StringField()), default: []
  });

  // Visible world settings
  reg(S.hexMax, {
    name: "Hexes per day",
    hint: "Number of segments in the hex clock. You can still go past it (forced march); the clock then gets a red ring.",
    scope: "world", config: true, type: Number, default: 4,
    range: { min: 1, max: 12, step: 1 }, onChange: rerender
  });
  reg(S.wildMax, {
    name: "Days in the wilderness before exhaustion",
    hint: "Number of segments in the wilderness clock. When it fills up, you choose who gains one level of exhaustion and the clock resets to 0.",
    scope: "world", config: true, type: Number, default: 3,
    range: { min: 1, max: 12, step: 1 }, onChange: rerender
  });
  reg(S.hexLabel, {
    name: "Hex tracker label", scope: "world", config: true,
    type: String, default: "Hexes Traveled", onChange: rerender
  });
  reg(S.wildLabel, {
    name: "Wilderness tracker label", scope: "world", config: true,
    type: String, default: "Days in the Wilderness", onChange: rerender
  });
  reg(S.hexPlayers, {
    name: "Players can see the hex tracker",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  reg(S.wildPlayers, {
    name: "Players can see the wilderness tracker",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  reg(S.publicChat, {
    name: "Exhaustion message visible to everyone",
    hint: "If off, the chat message listing who gained exhaustion is whispered to the GM only.",
    scope: "world", config: true, type: Boolean, default: true
  });

  // Per-browser positions
  reg(S.posHex, { scope: "client", config: false, type: new fields.ObjectField(), default: DEFAULT_POS.hex });
  reg(S.posWild, { scope: "client", config: false, type: new fields.ObjectField(), default: DEFAULT_POS.wild });
  reg(S.resetPos, {
    name: "Reset tracker positions",
    hint: "Tick and save to move both trackers back to the top-left corner.",
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
  game.modules.get(MOD).api = { newDay: () => Tracker.newDay() };
});

/* Prompt the GM whenever the in-game date moves forward to a new day */
Hooks.on("updateWorldTime", (worldTime, delta) => {
  if (!game.user.isGM || !(delta > 0)) return;
  if (game.users.activeGM?.id !== game.user.id) return;
  const spd = secondsPerDay();
  if (Math.floor(worldTime / spd) > Math.floor((worldTime - delta) / spd)) Tracker.newDay();
});

function secondsPerDay() {
  const d = game.time?.calendar?.days;
  return (d?.hoursPerDay ?? 24) * (d?.minutesPerHour ?? 60) * (d?.secondsPerMinute ?? 60);
}

/* -------------------------------------------- */
/*  Trackers                                    */
/* -------------------------------------------- */

class Tracker {
  static els = {};
  static #prompting = false;

  static config(kind) {
    return kind === "hex"
      ? { value: S.hexes, max: S.hexMax, label: S.hexLabel, players: S.hexPlayers, pos: S.posHex }
      : { value: S.wild, max: S.wildMax, label: S.wildLabel, players: S.wildPlayers, pos: S.posWild };
  }

  static destroy() {
    for (const el of Object.values(this.els)) el.remove();
    this.els = {};
  }

  static render() {
    if (!game.ready) return;
    for (const kind of ["hex", "wild"]) {
      const cfg = this.config(kind);
      const visible = game.user.isGM || get(cfg.players);
      if (!visible) {
        this.els[kind]?.remove();
        delete this.els[kind];
        continue;
      }
      this.els[kind] ??= this.#create(kind);
      this.#update(kind, this.els[kind]);
    }
  }

  static #create(kind) {
    const el = document.createElement("div");
    el.className = `wt-tracker wt-${kind}`;
    const pos = get(this.config(kind).pos);
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    document.body.appendChild(el);
    el.addEventListener("pointerdown", (ev) => this.#onPointerDown(ev, kind, el));
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (game.user.isGM) this.#adjust(kind, -1);
    });
    return el;
  }

  static #update(kind, el) {
    const cfg = this.config(kind);
    const value = get(cfg.value);
    const max = get(cfg.max);
    const hidden = game.user.isGM && !get(cfg.players);
    const over = value > max;
    el.classList.toggle("wt-gm", game.user.isGM);
    el.classList.toggle("wt-over", over);
    el.innerHTML = `
      <span class="wt-label">
        ${hidden ? `<i class="fa-solid fa-eye-slash"></i>` : ""}
        <span class="wt-text">${foundry.utils.escapeHTML(get(cfg.label))}${over ? ` (${value})` : ""}</span>
      </span>
      ${clockSVG(Math.min(value, max), max)}`;
  }

  /* ---------- Click = +1, right-click = −1, drag = move ---------- */

  static #onPointerDown(ev, kind, el) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const offX = ev.clientX - el.offsetLeft;
    const offY = ev.clientY - el.offsetTop;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let dragging = false;

    const move = (e) => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      el.classList.add("wt-dragging");
      const left = Math.min(Math.max(e.clientX - offX, 0), window.innerWidth - el.offsetWidth);
      const top = Math.min(Math.max(e.clientY - offY, 0), window.innerHeight - el.offsetHeight);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.classList.remove("wt-dragging");
      if (dragging) set(this.config(kind).pos, { left: el.offsetLeft, top: el.offsetTop });
      else if (game.user.isGM) this.#adjust(kind, +1);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  static async #adjust(kind, delta) {
    const cfg = this.config(kind);
    const next = Math.max(0, get(cfg.value) + delta);
    if (kind === "wild" && next >= get(S.wildMax)) {
      const applied = await applyExhaustion();
      if (applied) await set(S.wild, 0);
      return;
    }
    return set(cfg.value, next);
  }

  /* ---------- New day ---------- */

  static async newDay() {
    if (!game.user.isGM || this.#prompting) return;
    this.#prompting = true;
    try {
      const choice = await DialogV2().wait({
        window: { title: "A New Day", icon: "fa-solid fa-sun" },
        content: `<p>Did the party rest at a <b>safe haven</b> last night?</p>`,
        rejectClose: false,
        buttons: [
          { action: "yes", label: "Yes", icon: "fa-solid fa-house" },
          { action: "no", label: "No", icon: "fa-solid fa-tree", default: true }
        ]
      });
      if (choice !== "yes" && choice !== "no") return;

      await set(S.hexes, 0);
      if (choice === "yes") return set(S.wild, 0);

      const next = get(S.wild) + 1;
      if (next >= get(S.wildMax)) {
        await applyExhaustion();
        return set(S.wild, 0);
      }
      return set(S.wild, next);
    } finally {
      this.#prompting = false;
    }
  }
}

/** A circular clock split into `max` segments with `value` filled. */
function clockSVG(value, max) {
  const r = 15, c = 16;
  let filled = "";
  if (value >= max) filled = `<circle class="wt-on" cx="${c}" cy="${c}" r="${r}"/>`;
  else if (value > 0) {
    const a = (value / max) * 2 * Math.PI;
    const x = c + r * Math.sin(a), y = c - r * Math.cos(a);
    filled = `<path class="wt-on" d="M${c},${c} L${c},${c - r} A${r},${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x},${y} Z"/>`;
  }
  let lines = "";
  if (max > 1) for (let i = 0; i < max; i++) {
    const a = (i / max) * 2 * Math.PI;
    lines += `<line x1="${c}" y1="${c}" x2="${c + r * Math.sin(a)}" y2="${c - r * Math.cos(a)}"/>`;
  }
  return `<svg class="wt-clock" viewBox="0 0 32 32">
    <circle class="wt-off" cx="${c}" cy="${c}" r="${r}"/>${filled}${lines}
    <circle class="wt-ring" cx="${c}" cy="${c}" r="${r}"/></svg>`;
}

/* -------------------------------------------- */
/*  Exhaustion                                  */
/* -------------------------------------------- */

function partyActors() {
  let party;
  try { party = game.settings.get("dnd5e", "primaryParty")?.actor; } catch (e) { party = null; }
  const members = party?.system?.members;
  if (members?.length) {
    const actors = members.map((m) => m.actor ?? m).filter((a) => a instanceof Actor && a.type === "character");
    if (actors.length) return actors;
  }
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
    const owners = ownerNames(a);
    return `<label class="wt-pick">
      <input type="checkbox" name="target" value="${a.id}" ${defaults.has(a.id) ? "checked" : ""}>
      <img src="${a.img}" alt="">
      <span class="wt-pick-name">${a.name}${owners ? `<small>${owners}</small>` : ""}</span>
      <span class="wt-pick-lvl">${Number(a.system.attributes.exhaustion ?? 0)}</span>
    </label>`;
  }).join("");

  const ids = await DialogV2().wait({
    window: { title: "Exhaustion — who is affected?", icon: "fa-solid fa-bed" },
    position: { width: 380 },
    content: `<p>${get(S.wildMax)} days in the wilderness. Tick everyone who gains one level of exhaustion:</p>
      <div class="wt-pick-actions"><a data-pick="all">Select all</a> · <a data-pick="none">Select none</a></div>
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
    }, { action: "skip", label: "Skip", icon: "fa-solid fa-xmark" }]
  });

  if (!Array.isArray(ids)) return null;
  await set(S.lastTargets, ids);
  return ids.map((id) => game.actors.get(id)).filter(Boolean);
}

/** Returns true if the picker was confirmed (even with nobody ticked), false if skipped. */
async function applyExhaustion() {
  const actors = await chooseExhaustionTargets();
  if (actors === null) return false;
  if (!actors.length) return true;

  const maxLevel = CONFIG.DND5E?.conditionTypes?.exhaustion?.levels ?? 6;
  const lines = [];
  for (const actor of actors) {
    const current = Number(actor.system.attributes?.exhaustion ?? 0);
    const next = Math.min(current + 1, maxLevel);
    await actor.update({ "system.attributes.exhaustion": next });
    const warn = next >= maxLevel ? " <b>(maximum!)</b>" : "";
    lines.push(`<li>${actor.name}: ${current} → <b>${next}</b>${warn}</li>`);
  }

  const data = {
    content: `<p><b>${get(S.wildMax)} days in the wilderness — one level of exhaustion:</b></p><ul>${lines.join("")}</ul>`,
    speaker: { alias: "Wilderness Travel" }
  };
  if (!get(S.publicChat)) data.whisper = ChatMessage.getWhisperRecipients("GM");
  await ChatMessage.create(data);
  return true;
}
