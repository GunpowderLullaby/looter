const LOOTER_ID = "looter";
const SNAPSHOTS = new Map();
const PENDING_OPENS = new Map();

const STARTER_TREASURE_TYPES = [
  "Any",
  "None",
  "Arcana",
  "Armaments",
  "Individual",
  "Implements",
  "Relics"
];

const TIERS = ["0-4", "5-10", "11-16", "17+"];

const THEME_CHOICES = {
  violet: "Violet",
  emerald: "Emerald",
  crimson: "Crimson",
  amber: "Amber"
};

function log(...args) {
  console.log(`${LOOTER_ID} |`, ...args);
}

function clone(data) {
  return foundry.utils.deepClone(data);
}

function normalizeName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function clampNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tierFromCR(cr) {
  const n = clampNumber(cr, 0);
  if (n <= 4) return "0-4";
  if (n <= 10) return "5-10";
  if (n <= 16) return "11-16";
  return "17+";
}

function treasureTypesFromString(value) {
  return String(value ?? "")
    .split(/[;,|]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(titleCase);
}

function titleCase(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}


function sortMonsterRows(rows, sort = {}) {
  const field = ["name", "cr"].includes(sort?.field) ? sort.field : "name";
  const direction = sort?.direction === "desc" ? "desc" : "asc";
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (field === "cr") {
      const diff = clampNumber(a?.cr, 0) - clampNumber(b?.cr, 0);
      if (diff !== 0) return diff * factor;
      return String(a?.name ?? "").localeCompare(String(b?.name ?? "")) * factor;
    }
    const diff = String(a?.name ?? "").localeCompare(String(b?.name ?? ""), undefined, { sensitivity: "base" });
    if (diff !== 0) return diff * factor;
    return (clampNumber(a?.cr, 0) - clampNumber(b?.cr, 0)) * factor;
  });
}

function uniqueTreasureProfileTypes() {
  const seen = new Set();
  const out = [];
  for (const profile of getTreasureProfiles().map(normalizeProfile)) {
    const type = titleCase(profile?.type);
    if (!type || seen.has(type)) continue;
    seen.add(type);
    out.push(type);
  }
  if (!out.length) return [...STARTER_TREASURE_TYPES];
  return out.sort((a, b) => a.localeCompare(b));
}

function profileKey(type, tier) {
  return `${titleCase(type)} ${tier}`;
}

function tableName(type, tier) {
  return `Looter: ${titleCase(type)} ${tier}`;
}

function getTheme() {
  return game.settings.get(LOOTER_ID, "theme") || "violet";
}

function getUseXp() {
  return game.settings.get(LOOTER_ID, "useXp") !== false;
}

function getMonsterTable() {
  return clone(game.settings.get(LOOTER_ID, "monsterTable") ?? []);
}

async function setMonsterTable(rows) {
  await game.settings.set(LOOTER_ID, "monsterTable", rows);
}

function getTreasureProfiles() {
  return clone(game.settings.get(LOOTER_ID, "treasureProfiles") ?? []);
}

async function setTreasureProfiles(rows) {
  await game.settings.set(LOOTER_ID, "treasureProfiles", rows);
}

function defaultCurrencyBlock() {
  return { pp: "", gp: "", ep: "", sp: "", cp: "" };
}

function starterProfile(type, tier) {
  const currency = defaultCurrencyBlock();
  if (type === "Individual") {
    currency.gp = tier === "0-4" ? "2d6" : tier === "5-10" ? "6d6*10" : tier === "11-16" ? "4d6*100" : "8d6*100";
    currency.sp = tier === "0-4" ? "3d6" : tier === "5-10" ? "2d6*10" : "";
  } else if (type === "Any") {
    currency.gp = tier === "0-4" ? "1d6" : tier === "5-10" ? "3d6*10" : tier === "11-16" ? "6d6*25" : "8d6*50";
  }

  return {
    type: titleCase(type),
    tier,
    currency,
    tableRolls: "1",
    itemTable: type === "None" ? "" : tableName(type, tier)
  };
}

async function ensureWorldTables() {
  const rootName = "Looter Tables";
  let root = game.folders.find(f => f.type === "RollTable" && f.name === rootName && !f.folder);
  if (!root) root = await Folder.create({ name: rootName, type: "RollTable", color: "#7c3aed" });

  for (const type of STARTER_TREASURE_TYPES.filter(t => t !== "None")) {
    for (const tier of TIERS) {
      const name = tableName(type, tier);
      if (game.tables.find(t => t.name === name)) continue;
      await RollTable.create({
        name,
        folder: root.id,
        description: `Starter Looter item table for ${type} ${tier}. Add text results to represent item names or treasure bundles.`,
        formula: "1d1",
        results: [{
          type: CONST.TABLE_RESULT_TYPES.TEXT,
          text: `${type} ${tier} treasure`,
          description: starterItemName(type, tier),
          range: [1, 1],
          weight: 1,
          drawn: false
        }]
      });
      log("Created starter table", name);
    }
  }
}

function starterItemName(type, tier) {
  if (type === "Arcana") return tier === "0-4" ? "Spell Scroll (Cantrip)" : tier === "5-10" ? "Potion of Healing" : tier === "11-16" ? "Spell Scroll (3rd Level)" : "Spell Scroll (5th Level)";
  if (type === "Armaments") return tier === "0-4" ? "Dagger" : tier === "5-10" ? "Longsword" : tier === "11-16" ? "+1 Weapon" : "+2 Weapon";
  if (type === "Implements") return tier === "0-4" ? "Healer's Kit" : tier === "5-10" ? "Wand" : tier === "11-16" ? "Pearl of Power" : "Staff of Power";
  if (type === "Relics") return tier === "0-4" ? "Holy Symbol" : tier === "5-10" ? "Prayer Beads" : tier === "11-16" ? "Amulet of Health" : "Holy Avenger";
  return tier === "0-4" ? "Coin Purse" : tier === "5-10" ? "Gemstone" : tier === "11-16" ? "Art Object" : "Magic Treasure";
}

function mergeProfileWithStarter(row) {
  const normalized = normalizeProfile(row);
  const starter = starterProfile(normalized.type, normalized.tier);
  return {
    type: normalized.type,
    tier: normalized.tier,
    currency: {
      pp: normalized.currency.pp || starter.currency.pp || "",
      gp: normalized.currency.gp || starter.currency.gp || "",
      ep: normalized.currency.ep || starter.currency.ep || "",
      sp: normalized.currency.sp || starter.currency.sp || "",
      cp: normalized.currency.cp || starter.currency.cp || ""
    },
    tableRolls: String(normalized.tableRolls || starter.tableRolls || "1").trim() || "1",
    itemTable: normalized.itemTable || starter.itemTable || ""
  };
}

async function ensureTreasureProfiles() {
  const existing = getTreasureProfiles();
  const byKey = new Map();
  let changed = false;

  for (const row of existing) {
    const merged = mergeProfileWithStarter(row);
    const original = normalizeProfile(row);
    if (JSON.stringify(merged) !== JSON.stringify(original)) changed = true;
    byKey.set(profileKey(merged.type, merged.tier), merged);
  }

  for (const type of STARTER_TREASURE_TYPES) {
    for (const tier of TIERS) {
      const key = profileKey(type, tier);
      if (byKey.has(key)) continue;
      byKey.set(key, starterProfile(type, tier));
      changed = true;
    }
  }

  if (changed || !existing.length) {
    await setTreasureProfiles([...byKey.values()]);
    log("Treasure profiles ready", byKey.size);
  }
}

function normalizeProfile(row) {
  return {
    type: titleCase(row.type),
    tier: TIERS.includes(row.tier) ? row.tier : tierFromCR(row.tier),
    currency: {
      pp: String(row?.currency?.pp ?? "").trim(),
      gp: String(row?.currency?.gp ?? "").trim(),
      ep: String(row?.currency?.ep ?? "").trim(),
      sp: String(row?.currency?.sp ?? "").trim(),
      cp: String(row?.currency?.cp ?? "").trim()
    },
    tableRolls: String(row?.tableRolls ?? "1").trim() || "1",
    itemTable: String(row.itemTable ?? "").trim()
  };
}

function findTreasureProfile(type, tier) {
  const key = profileKey(type, tier);
  return getTreasureProfiles().map(mergeProfileWithStarter).find(p => profileKey(p.type, p.tier) === key) ?? null;
}

function normalizeCurrencyFormula(formula) {
  return String(formula ?? "")
    .trim()
    .replace(/[×x]/g, "*")
    .replace(/\s+/g, "");
}

async function parseRollFormulaValue(formula) {
  const text = normalizeCurrencyFormula(formula);
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);

  try {
    const roll = Roll.create ? Roll.create(text) : new Roll(text);
    if (typeof roll.evaluate === "function") await roll.evaluate({ allowInteractive: false });
    else if (typeof roll.evaluateSync === "function") roll.evaluateSync({ allowInteractive: false });
    return Number(roll.total ?? 0);
  } catch (err) {
    console.warn(`${LOOTER_ID} | Failed to evaluate currency formula`, text, err);
    return 0;
  }
}

function getTableResultSource(result) {
  try {
    return result?.toObject ? result.toObject(false) : (result ?? null);
  } catch (_err) {
    return result ?? null;
  }
}

function getTableResultLabel(result) {
  const source = getTableResultSource(result);
  return String(source?.name || source?.description || result?.name || result?.description || "").trim();
}

function getRollTableReference(table) {
  if (!table) return "";
  return table.uuid || (table.pack ? `Compendium.${table.pack}.${table.id}` : `RollTable.${table.id}`);
}

function findRollTableByReference(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return null;
  if (/^RollTable\./.test(ref)) {
    const id = ref.split(".")[1] || "";
    return game.tables.get(id) ?? null;
  }
  if (/^Compendium\./.test(ref)) {
    const parts = ref.split(".");
    if (parts.length >= 4) {
      const packName = `${parts[1]}.${parts[2]}`;
      const pack = game.packs.get(packName);
      if (pack?.documentName === "RollTable") return { pack, id: parts[3], uuid: ref, name: ref };
    }
  }
  return game.tables.find(t => t.name === ref) ?? null;
}

async function resolveRollTableByReference(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return null;
  if (/^Compendium\./.test(ref)) {
    try {
      const doc = await fromUuid(ref);
      if (doc?.documentName === "RollTable") return doc;
    } catch (err) {
      console.warn(`${LOOTER_ID} | Failed to resolve roll table by UUID`, ref, err);
    }
  }
  return findRollTableByReference(ref);
}

function getRollTableDisplayName(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return "";
  const table = findRollTableByReference(ref);
  return table?.name || ref;
}

async function resolveTableResultDocument(result) {
  if (!result) return null;

  const source = getTableResultSource(result) || {};
  const resultType = source?.type;
  if (resultType === CONST.TABLE_RESULT_TYPES.TEXT) return null;

  const documentUuid = String(source?.documentUuid || source?.uuid || result?.documentUuid || "").trim();
  try {
    if (documentUuid && documentUuid.includes(".")) {
      const doc = await fromUuid(documentUuid);
      if (doc) return doc;
    }
  } catch (err) {
    console.warn(`${LOOTER_ID} | Failed to resolve table result document via documentUuid`, { documentUuid, err, source });
  }

  const collection = String(source?.collection || source?.pack || "").trim();
  const docId = String(source?.documentId || source?.resultId || source?._id || "").trim();

  try {
    if (String(collection).startsWith("Compendium.") && docId) {
      const doc = await fromUuid(`${collection}.${docId}`);
      if (doc) return doc;
    }

    if (/^item$/i.test(collection) && docId) return game.items.get(docId) ?? null;
    if (/^rolltable$/i.test(collection) && docId) return game.tables.get(docId) ?? null;
  } catch (err) {
    console.warn(`${LOOTER_ID} | Failed to resolve table result document via legacy fallback`, { collection, docId, err, source });
  }

  return null;
}

function itemPayloadFromDocument(doc, sourceType, tier) {
  const itemData = doc.toObject ? doc.toObject() : foundry.utils.deepClone(doc);
  delete itemData._id;
  delete itemData.folder;
  delete itemData.sort;
  return {
    id: foundry.utils.randomID(),
    name: itemData?.name || doc.name,
    img: itemData?.img || doc.img || "icons/commodities/treasure/chest-worn-oak-gold-white.webp",
    sourceType,
    tier,
    itemData,
    sourceUuid: doc.uuid || null
  };
}

async function drawItemsFromTable(tableReference, sourceType, tier, drawCount = 1) {
  const items = [];
  const ref = String(tableReference ?? "").trim();
  if (!ref) return items;
  const table = await resolveRollTableByReference(ref);
  if (!table) {
    console.warn(`${LOOTER_ID} | Missing roll table`, ref);
    return items;
  }

  const draws = Math.max(0, Math.floor(clampNumber(drawCount, 1)));
  for (let n = 0; n < draws; n += 1) {
    const draw = await table.draw({ displayChat: false, rollMode: CONST.DICE_ROLL_MODES.PRIVATE });
    const results = Array.isArray(draw?.results) ? draw.results : [];
    for (const result of results) {
      try {
        const doc = await resolveTableResultDocument(result);
        if (doc?.documentName === "Item" || (doc && doc.type && doc.name)) {
          items.push(itemPayloadFromDocument(doc, sourceType, tier));
          continue;
        }

        const label = getTableResultLabel(result);
        if (!label) continue;
        items.push({
          id: foundry.utils.randomID(),
          name: label,
          img: "icons/commodities/treasure/chest-worn-oak-gold-white.webp",
          sourceType,
          tier,
          itemData: null
        });
      } catch (err) {
        console.warn(`${LOOTER_ID} | Failed to process table result for ${ref}`, err, getTableResultSource(result));
      }
    }
  }
  return items;
}

async function rollFromTreasurePlan(entry) {
  const currency = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  const items = [];
  const types = Array.isArray(entry.treasureTypes) ? entry.treasureTypes : [];
  const tier = tierFromCR(entry.cr);

  for (const type of types) {
    const normalizedType = titleCase(type);
    if (!normalizedType || /^none$/i.test(normalizedType)) continue;
    const profile = findTreasureProfile(normalizedType, tier) || findTreasureProfile("Any", tier);
    if (!profile) continue;

    for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
      const value = await parseRollFormulaValue(profile.currency?.[denom]);
      currency[denom] += value;
    }

    const tableRolls = await parseRollFormulaValue(profile.tableRolls || "1");
    const drawnItems = await drawItemsFromTable(profile.itemTable, normalizedType, tier, tableRolls);
    items.push(...drawnItems);
  }

  return { currency, items };
}

function findMonsterEntryByName(name) {
  const wanted = normalizeName(name);
  return getMonsterTable().find(row => normalizeName(row.name) === wanted) ?? null;
}

function treasureTypesFromActor(actor) {
  const raw = actor?.system?.details?.treasure?.value
    ?? actor?._source?.system?.details?.treasure?.value
    ?? actor?.toObject?.(false)?.system?.details?.treasure?.value;

  if (Array.isArray(raw)) return raw.map(titleCase).filter(Boolean);
  if (typeof raw === "string") return treasureTypesFromString(raw);
  if (raw && Array.isArray(raw.value)) return raw.value.map(titleCase).filter(Boolean);
  if (raw && typeof raw.value === "string") return treasureTypesFromString(raw.value);
  return [];
}

async function resolveDroppedActor(event) {
  const dragEvent = event?.originalEvent ?? event;
  let data = null;

  try {
    data = TextEditor.getDragEventData(dragEvent);
  } catch (_err) {
    data = null;
  }

  if (!data) return null;

  try {
    if (typeof data.uuid === "string" && data.uuid) {
      const doc = await fromUuid(data.uuid);
      if (doc?.documentName === "Actor") return doc;
    }

    if (data.type === "Actor" && data.id) {
      return game.actors.get(data.id) ?? null;
    }
  } catch (err) {
    console.warn(`${LOOTER_ID} | Failed to resolve dropped actor`, err, data);
  }

  return null;
}

function monsterRowFromActor(actor) {
  return {
    name: String(actor?.name ?? "").trim(),
    cr: clampNumber(foundry.utils.getProperty(actor, "system.details.cr"), 0),
    xp: clampNumber(foundry.utils.getProperty(actor, "system.details.xp.value"), 0),
    treasureTypes: treasureTypesFromActor(actor)
  };
}

function getDefeatedCombatants(combat) {
  return combat.combatants.filter(c => {
    if (c.actor?.type === "character") return false;
    if (c.defeated) return true;
    const hp = foundry.utils.getProperty(c.actor, "system.attributes.hp.value");
    return Number.isFinite(hp) ? hp <= 0 : false;
  });
}

function getParticipatingCharacters(combat) {
  return combat.combatants.filter(c => c.actor?.type === "character" && c.actor?.hasPlayerOwner);
}

async function buildEncounterSnapshot(combat) {
  const enemies = [];
  const players = getParticipatingCharacters(combat).map(c => ({
    actorId: c.actor.id,
    combatantId: c.id,
    name: c.actor.name,
    img: c.actor.img,
    enabled: true
  }));

  const totalCurrency = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  let totalXp = 0;
  const lootItems = [];

  for (const combatant of getDefeatedCombatants(combat)) {
    const actor = combatant.actor;
    const fallbackCr = clampNumber(foundry.utils.getProperty(actor, "system.details.cr"), 0);
    const fallbackXp = clampNumber(foundry.utils.getProperty(actor, "system.details.xp.value"), 0);
    const matched = findMonsterEntryByName(actor?.name);
    const entry = matched ?? { name: actor?.name ?? combatant.name, cr: fallbackCr, xp: fallbackXp, treasureTypes: [] };

    enemies.push({
      combatantId: combatant.id,
      actorId: actor?.id,
      name: actor?.name ?? combatant.name,
      img: actor?.img ?? "icons/svg/mystery-man.svg",
      cr: clampNumber(entry.cr, fallbackCr),
      xp: clampNumber(entry.xp, fallbackXp),
      treasureTypes: Array.isArray(entry.treasureTypes) ? [...entry.treasureTypes] : [],
      matched: Boolean(matched)
    });

    totalXp += clampNumber(entry.xp, fallbackXp);
    const rolled = await rollFromTreasurePlan(entry);
    for (const denom of ["pp", "gp", "ep", "sp", "cp"]) totalCurrency[denom] += clampNumber(rolled.currency[denom], 0);
    lootItems.push(...rolled.items);
  }

  return {
    combatId: combat.id,
    combatName: combat.name,
    enemies,
    players,
    totals: {
      xp: totalXp,
      currency: totalCurrency,
      items: lootItems
    }
  };
}

function distributeCurrency(currency, players) {
  const active = players.filter(p => p.enabled && p.actor);
  const result = new Map(active.map(p => [p.actor.id, { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }]));
  if (!active.length) return result;

  for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
    const total = clampNumber(currency[denom], 0);
    const share = Math.floor(total / active.length);
    const remainder = total % active.length;
    active.forEach((p, idx) => {
      result.get(p.actor.id)[denom] = share + (idx < remainder ? 1 : 0);
    });
  }
  return result;
}

async function grantRewards(payload) {
  const players = payload.players.map(p => ({ ...p, actor: game.actors.get(p.actorId) })).filter(p => p.actor);
  const split = distributeCurrency(payload.currency, players);
  const activePlayers = players.filter(p => p.enabled);
  const xpShare = getUseXp() && activePlayers.length ? Math.floor(clampNumber(payload.xp, 0) / activePlayers.length) : 0;

  for (const player of activePlayers) {
    const actor = player.actor;
    const currentCurrency = foundry.utils.deepClone(actor.system.currency ?? {});
    const additions = split.get(actor.id) ?? { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
    const updateData = {};

    for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
      const current = clampNumber(currentCurrency[denom], 0);
      updateData[`system.currency.${denom}`] = current + clampNumber(additions[denom], 0);
    }

    if (getUseXp()) {
      const currentXp = clampNumber(foundry.utils.getProperty(actor, "system.details.xp.value"), 0);
      updateData["system.details.xp.value"] = currentXp + xpShare;
    }

    await actor.update(updateData);
  }

  for (const item of payload.items) {
    if (!item.assignee) continue;
    const actor = game.actors.get(item.assignee);
    if (!actor) continue;

    const embedded = item.itemData ? foundry.utils.deepClone(item.itemData) : {
      name: item.name,
      type: "loot",
      img: item.img || "icons/commodities/treasure/chest-worn-oak-gold-white.webp",
      system: {}
    };

    delete embedded._id;
    await actor.createEmbeddedDocuments("Item", [embedded]);
  }
}

function rewardsSummaryHTML(payload) {
  const playerNames = payload.players.filter(p => p.enabled).map(p => p.name).join(", ") || "No one";
  const loot = payload.items.map(i => `<li>${i.name}${i.assigneeName ? ` → ${i.assigneeName}` : ""}</li>`).join("");
  const currencyBits = ["pp", "gp", "ep", "sp", "cp"].map(d => `${payload.currency[d] ?? 0} ${d}`).join(", ");
  return `
  <div class="looter-chat-summary">
    <h3>Looter Rewards</h3>
    <p><strong>Recipients:</strong> ${playerNames}</p>
    <p><strong>XP:</strong> ${payload.xp}</p>
    <p><strong>Currency:</strong> ${currencyBits}</p>
    <ul>${loot || "<li>No items</li>"}</ul>
  </div>`;
}

function stackEnemiesForDisplay(enemies = []) {
  const groups = new Map();

  for (const enemy of enemies) {
    const key = [normalizeName(enemy.name), String(enemy.cr), String(enemy.xp), (enemy.treasureTypes || []).join("|")].join("::");
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalXp += clampNumber(enemy.xp, 0);
      continue;
    }

    groups.set(key, {
      ...enemy,
      count: 1,
      totalXp: clampNumber(enemy.xp, 0)
    });
  }

  return Array.from(groups.values()).map(enemy => ({
    ...enemy,
    isStacked: enemy.count > 1,
    displayName: enemy.count > 1 ? `${enemy.name} ×${enemy.count}` : enemy.name
  }));
}

class LooterMonsterTableApp extends FormApplication {
  constructor(options = {}) {
    super(options);
    this._monsterSort = { field: "name", direction: "asc" };
    this._typePopover = null;
    this._boundDocumentPointerDown = this._onDocumentPointerDown.bind(this);
    this._boundWindowResize = this._repositionTypePopover.bind(this);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "looter-monster-table",
      title: "Monster Registry",
      template: `modules/${LOOTER_ID}/templates/monster-table.html`,
      width: 1280,
      height: 820,
      resizable: true,
      closeOnSubmit: false,
      submitOnChange: false,
      submitOnClose: false,
      classes: ["looter-app", `theme-${getTheme()}`]
    });
  }

  getData() {
    const profiles = getTreasureProfiles().map(normalizeProfile);
    const rows = sortMonsterRows(getMonsterTable(), this._monsterSort).map((row, index) => ({
      ...row,
      index,
      treasureTypesValue: (row.treasureTypes || []).join(", ")
    }));

    return {
      rows,
      treasureTypeOptions: uniqueTreasureProfileTypes(),
      monsterSort: {
        field: this._monsterSort.field,
        direction: this._monsterSort.direction,
        nameLabel: this._monsterSort.field === "name" ? (this._monsterSort.direction === "asc" ? "▲" : "▼") : "",
        crLabel: this._monsterSort.field === "cr" ? (this._monsterSort.direction === "asc" ? "▲" : "▼") : ""
      },
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const importDropzone = html[0].querySelector("[data-import-dropzone]");
    if (importDropzone) {
      importDropzone.addEventListener("dragover", this._onMonsterDropOver.bind(this));
      importDropzone.addEventListener("dragleave", this._onMonsterDropLeave.bind(this));
      importDropzone.addEventListener("drop", this._onMonsterImportDrop.bind(this));
    }

    html.find(".looter-sort-monsters").on("click", ev => {
      ev.preventDefault();
      const field = String(ev.currentTarget.dataset.field || "name");
      if (this._monsterSort.field === field) this._monsterSort.direction = this._monsterSort.direction === "asc" ? "desc" : "asc";
      else this._monsterSort = { field, direction: "asc" };
      this.render(false);
    });

    html.find(".looter-type-selector").on("click", ev => {
      ev.preventDefault();
      this._toggleTypePopover(ev.currentTarget);
    });

    html.find(".looter-add-row").on("click", ev => {
      ev.preventDefault();
      const rows = this._collectMonsterRows(html[0]);
      rows.push({ name: "", cr: 0, xp: 0, treasureTypes: [] });
      setMonsterTable(rows).then(() => this.render(false));
    });

    html.find(".looter-save").on("click", ev => {
      ev.preventDefault();
      this._saveFromForm(html[0]);
    });

    html.find(".looter-delete-row").on("click", ev => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.index);
      const rows = this._collectMonsterRows(html[0]);
      rows.splice(idx, 1);
      setMonsterTable(rows).then(() => this.render(false));
    });

    html.find(".looter-open-profiles").on("click", ev => {
      ev.preventDefault();
      openTreasureProfilesApp();
    });
  }

  _collectMonsterRows(root) {
    const rows = [];
    for (const row of root.querySelectorAll("tbody.looter-monsters tr[data-index]")) {
      const idx = Number(row.dataset.index);
      if (!Number.isFinite(idx)) continue;
      const name = row.querySelector(`[name="rows.${idx}.name"]`)?.value?.trim() || "";
      const cr = clampNumber(row.querySelector(`[name="rows.${idx}.cr"]`)?.value, 0);
      const xp = clampNumber(row.querySelector(`[name="rows.${idx}.xp"]`)?.value, 0);
      const rawTreasureTypes = row.querySelector(`[name="rows.${idx}.treasureTypes"]`)?.value || "";
      const treasureTypes = treasureTypesFromString(rawTreasureTypes);
      if (!name) continue;
      rows.push({ name, cr, xp, treasureTypes });
    }
    return rows;
  }

  _readRowTreasureTypes(row) {
    const input = row?.querySelector('input[name$=".treasureTypes"]');
    return treasureTypesFromString(input?.value || "");
  }

  _writeRowTreasureTypes(row, types) {
    const normalized = [...new Set((types || []).map(titleCase).filter(Boolean))];
    const input = row?.querySelector('input[name$=".treasureTypes"]');
    if (input) input.value = normalized.join(", ");
    const chips = row?.querySelector(".looter-type-selector-chips");
    if (chips) {
      chips.innerHTML = normalized.length
        ? normalized.map(type => `<span class="looter-chip">${foundry.utils.escapeHTML(type)}</span>`).join("")
        : `<span class="looter-type-selector-placeholder">Select treasure types</span>`;
    }
    if (this._typePopover && this._typePopover.row === row) this._typePopover.types = normalized;
  }

  _toggleTypePopover(button) {
    const row = button?.closest?.("tr[data-index]");
    if (!row) return;
    if (this._typePopover?.row === row) {
      this._closeTypePopover();
      return;
    }
    this._openTypePopover(button, row);
  }

  _openTypePopover(button, row) {
    this._closeTypePopover();
    const options = uniqueTreasureProfileTypes();
    const selected = this._readRowTreasureTypes(row);
    const popover = document.createElement("div");
    popover.className = "looter-type-popover";
    popover.innerHTML = `
      <div class="looter-type-popover-header">
        <span>Treasure Types</span>
        <div class="looter-type-popover-actions">
          <button type="button" class="looter-type-clear">Clear</button>
          <button type="button" class="looter-type-done">Done</button>
        </div>
      </div>
      <div class="looter-type-popover-list">
        ${options.length ? options.map(type => `
          <label>
            <input type="checkbox" value="${foundry.utils.escapeHTML(type)}" ${selected.includes(type) ? "checked" : ""}>
            <span>${foundry.utils.escapeHTML(type)}</span>
          </label>
        `).join("") : `<div class="looter-muted">Add treasure profile types first.</div>`}
      </div>`;
    document.body.appendChild(popover);
    this._typePopover = { el: popover, button, row, types: selected };
    button.setAttribute("aria-expanded", "true");

    popover.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", () => {
      const types = [...popover.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
      this._writeRowTreasureTypes(row, types);
    }));
    popover.querySelector(".looter-type-clear")?.addEventListener("click", ev => {
      ev.preventDefault();
      popover.querySelectorAll('input[type="checkbox"]').forEach(i => i.checked = false);
      this._writeRowTreasureTypes(row, []);
    });
    popover.querySelector(".looter-type-done")?.addEventListener("click", ev => {
      ev.preventDefault();
      this._closeTypePopover();
    });

    document.addEventListener("pointerdown", this._boundDocumentPointerDown, true);
    window.addEventListener("resize", this._boundWindowResize);
    this._repositionTypePopover();
  }

  _repositionTypePopover() {
    const state = this._typePopover;
    if (!state?.el || !state?.button?.isConnected) return;
    const margin = 12;
    const rect = state.button.getBoundingClientRect();
    const el = state.el;
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - margin * 2);
    el.style.width = `${width}px`;
    const pop = el.getBoundingClientRect();
    let left = Math.min(rect.left, window.innerWidth - pop.width - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 6;
    if (top + pop.height > window.innerHeight - margin) top = Math.max(margin, rect.top - pop.height - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  }

  _onDocumentPointerDown(event) {
    const state = this._typePopover;
    if (!state) return;
    const target = event.target;
    if (state.el.contains(target) || state.button.contains(target)) return;
    this._closeTypePopover();
  }

  _closeTypePopover() {
    const state = this._typePopover;
    if (!state) return;
    state.button?.setAttribute("aria-expanded", "false");
    state.el?.remove();
    document.removeEventListener("pointerdown", this._boundDocumentPointerDown, true);
    window.removeEventListener("resize", this._boundWindowResize);
    this._typePopover = null;
  }

  _setMonsterDropState(target, active) {
    const zone = target?.closest?.("[data-import-dropzone]") || target;
    if (!zone) return;
    zone.classList.toggle("is-drop-target", active);
  }

  _onMonsterDropOver(event) {
    event.preventDefault();
    this._setMonsterDropState(event.currentTarget, true);
    if ((event.originalEvent ?? event).dataTransfer) (event.originalEvent ?? event).dataTransfer.dropEffect = "copy";
  }

  _onMonsterDropLeave(event) {
    this._setMonsterDropState(event.currentTarget, false);
  }

  async _importActorToRows(event) {
    event.preventDefault();
    this._setMonsterDropState(event.currentTarget, false);

    const actor = await resolveDroppedActor(event);
    if (!actor) {
      ui.notifications.warn("Drop an Actor into the Looter import area.");
      return;
    }
    if (actor.type !== "npc") {
      ui.notifications.warn("Only NPC actors can be imported into Looter.");
      return;
    }

    const root = this.form ?? this.element?.[0];
    const rows = root ? this._collectMonsterRows(root) : getMonsterTable();
    const imported = monsterRowFromActor(actor);
    if (!imported.name) return;

    const existingIndex = rows.findIndex(row => normalizeName(row.name) === normalizeName(imported.name));
    if (existingIndex >= 0) {
      const shouldOverwrite = await Dialog.confirm({
        title: "Overwrite Monster Entry?",
        content: `<p>An entry named <strong>${foundry.utils.escapeHTML(imported.name)}</strong> already exists in Looter.</p><p>Do you want to overwrite it with the dragged actor's data?</p>`,
        yes: () => true,
        no: () => false,
        defaultYes: false
      });
      if (!shouldOverwrite) {
        ui.notifications.info(`Looter skipped importing ${imported.name}.`);
        return;
      }

      rows[existingIndex] = imported;
      await setMonsterTable(rows);
      ui.notifications.info(`Looter updated ${imported.name}.`);
      this.render(false);
      return;
    }

    rows.push(imported);
    await setMonsterTable(rows);
    ui.notifications.info(`Looter imported ${imported.name}.`);
    this.render(false);
  }

  async _onMonsterImportDrop(event) {
    await this._importActorToRows(event);
  }

  async _saveFromForm(root) {
    const rows = this._collectMonsterRows(root);
    await setMonsterTable(rows);
    ui.notifications.info("Looter monster registry saved.");
    this.render(false);
  }

  async close(options) {
    return super.close(options);
  }

  async _updateObject(_event, _formData) {}
}


class LooterTreasureProfilesApp extends FormApplication {
  constructor(options = {}) {
    super(options);
    this._tablePicker = null;
    this._boundTablePickerClick = this._onTablePickerClick.bind(this);
    this._boundTablePickerKeydown = this._onTablePickerKeydown.bind(this);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "looter-treasure-profiles",
      title: "Treasure Profiles",
      template: `modules/${LOOTER_ID}/templates/treasure-profiles.html`,
      width: 1280,
      height: 820,
      resizable: true,
      closeOnSubmit: false,
      submitOnChange: false,
      submitOnClose: false,
      classes: ["looter-app", `theme-${getTheme()}`]
    });
  }

  getData() {
    return {
      profiles: getTreasureProfiles().map((profile, index) => {
        const normalized = normalizeProfile(profile);
        return {
          ...normalized,
          index,
          tableRolls: normalized.tableRolls || "1",
          itemTableDisplay: getRollTableDisplayName(normalized.itemTable)
        };
      }),
      starterTypes: STARTER_TREASURE_TYPES,
      tiers: TIERS
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find(".looter-open-monsters").on("click", ev => {
      ev.preventDefault();
      openMonsterTableApp();
    });

    html.find(".looter-add-profile").on("click", ev => {
      ev.preventDefault();
      const profiles = getTreasureProfiles();
      profiles.push({ type: "Any", tier: "0-4", currency: defaultCurrencyBlock(), tableRolls: "1", itemTable: tableName("Any", "0-4") });
      setTreasureProfiles(profiles).then(() => this.render(false));
    });

    html.find(".looter-delete-profile").on("click", ev => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.index);
      const profiles = getTreasureProfiles();
      profiles.splice(idx, 1);
      setTreasureProfiles(profiles).then(() => this.render(false));
    });

    html.find(".looter-save").on("click", ev => {
      ev.preventDefault();
      this._saveFromForm(html[0]);
    });

    html.find(".looter-seed-tables").on("click", async ev => {
      ev.preventDefault();
      await ensureWorldTables();
      ui.notifications.info("Looter starter item tables are ready in the Roll Tables directory.");
    });

    html.find(".looter-seed-profiles").on("click", async ev => {
      ev.preventDefault();
      await ensureTreasureProfiles();
      ui.notifications.info("Looter starter treasure profiles are ready.");
      this.render(false);
    });

    html.find(".looter-pick-table").on("click", async ev => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.index);
      if (!Number.isFinite(idx)) return;
      await this._startTablePicker(idx);
    });

    html.find(".looter-clear-table").on("click", async ev => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.index);
      if (!Number.isFinite(idx)) return;
      await this._clearLinkedTable(idx);
    });
  }

  async _startTablePicker(index) {
    const root = this.form ?? this.element?.[0];
    if (!root) return;
    await this._saveFromForm(root, { notify: false, rerender: false });

    this._tablePicker = { index };
    if (typeof ui.sidebar?.changeTab === "function") ui.sidebar.changeTab("tables", "primary");
    else ui.sidebar?.activateTab?.("tables");
    ui.tables?.render?.(true);
    await this.minimize();
    ui.notifications.info("Looter table picker active. Click a RollTable in the Roll Tables directory to link it, or press Escape to cancel.");
    document.addEventListener("click", this._boundTablePickerClick, true);
    document.addEventListener("keydown", this._boundTablePickerKeydown, true);
  }

  async _finishTablePicker() {
    document.removeEventListener("click", this._boundTablePickerClick, true);
    document.removeEventListener("keydown", this._boundTablePickerKeydown, true);
    this._tablePicker = null;
    try {
      await this.maximize();
    } catch (_err) {
      this.render(false);
    }
  }

  async _cancelTablePicker(notify = true) {
    if (!this._tablePicker) return;
    await this._finishTablePicker();
    if (notify) ui.notifications.info("Looter table picker cancelled.");
  }

  _extractRollTableIdFromElement(target) {
    const item = target?.closest?.('.directory-item.document, .document.rolltable, li.document.rolltable, li[data-document-id], li[data-entry-id]');
    if (!item) return null;
    if (ui.tables?.element?.[0] && !ui.tables.element[0].contains(item)) return null;
    return item.dataset.documentId || item.dataset.entryId || item.dataset.id || null;
  }

  async _onTablePickerClick(event) {
    if (!this._tablePicker) return;
    const docId = this._extractRollTableIdFromElement(event.target);
    if (!docId) return;

    const table = game.tables.get(docId);
    if (!table) return;

    event.preventDefault();
    event.stopPropagation();

    const profiles = getTreasureProfiles().map(normalizeProfile);
    const idx = this._tablePicker.index;
    if (!profiles[idx]) {
      await this._cancelTablePicker(false);
      return;
    }

    profiles[idx].itemTable = getRollTableReference(table);
    await setTreasureProfiles(profiles);
    await this._finishTablePicker();
    ui.notifications.info(`Looter linked ${table.name}.`);
    this.render(false);
  }

  async _onTablePickerKeydown(event) {
    if (!this._tablePicker || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    await this._cancelTablePicker();
  }

  async _clearLinkedTable(index) {
    const root = this.form ?? this.element?.[0];
    if (!root) return;

    await this._saveFromForm(root, { notify: false, rerender: false });

    const profiles = getTreasureProfiles().map(normalizeProfile);
    if (!profiles[index]) return;

    profiles[index].itemTable = "";
    await setTreasureProfiles(profiles);

    const row = root.querySelector(`tbody.looter-profiles tr[data-index="${index}"]`);
    const hiddenInput = row?.querySelector(`[name="profiles.${index}.itemTable"]`);
    const displayInput = row?.querySelector(".looter-table-display");
    if (hiddenInput) hiddenInput.value = "";
    if (displayInput) displayInput.value = "";

    ui.notifications.info("Looter cleared the linked RollTable for that profile.");
  }

  async _saveFromForm(root, { notify = true, rerender = true } = {}) {
    const profiles = [];
    for (const row of root.querySelectorAll("tbody.looter-profiles tr[data-index]")) {
      const idx = Number(row.dataset.index);
      if (!Number.isFinite(idx)) continue;
      const type = titleCase(row.querySelector(`[name="profiles.${idx}.type"]`)?.value || "");
      const tier = String(row.querySelector(`[name="profiles.${idx}.tier"]`)?.value || "0-4");
      if (!type) continue;
      profiles.push(normalizeProfile({
        type,
        tier,
        currency: {
          pp: row.querySelector(`[name="profiles.${idx}.currency.pp"]`)?.value || "",
          gp: row.querySelector(`[name="profiles.${idx}.currency.gp"]`)?.value || "",
          ep: row.querySelector(`[name="profiles.${idx}.currency.ep"]`)?.value || "",
          sp: row.querySelector(`[name="profiles.${idx}.currency.sp"]`)?.value || "",
          cp: row.querySelector(`[name="profiles.${idx}.currency.cp"]`)?.value || ""
        },
        tableRolls: row.querySelector(`[name="profiles.${idx}.tableRolls"]`)?.value || "1",
        itemTable: row.querySelector(`[name="profiles.${idx}.itemTable"]`)?.value || ""
      }));
    }

    await setTreasureProfiles(profiles);
    if (notify) ui.notifications.info("Looter treasure profiles saved.");
    if (rerender) this.render(false);
  }

  async close(options) {
    await this._cancelTablePicker(false);
    return super.close(options);
  }

  async _updateObject(_event, _formData) {}
}

class LooterEncounterApp extends FormApplication {
  constructor(snapshot, options = {}) {
    super(options);
    this.snapshot = clone(snapshot);
    this.state = {
      enemies: clone(snapshot.enemies),
      players: snapshot.players.map(p => ({ ...p })),
      xp: clampNumber(snapshot.totals.xp, 0),
      currency: clone(snapshot.totals.currency),
      items: snapshot.totals.items.map(i => ({ ...i, assignee: "" }))
    };
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "looter-encounter-rewards",
      title: "Looter Rewards",
      template: `modules/${LOOTER_ID}/templates/encounter-rewards.html`,
      width: 1180,
      height: 760,
      resizable: true,
      closeOnSubmit: false,
      submitOnChange: false,
      submitOnClose: false,
      classes: ["looter-app", "looter-encounter", `theme-${getTheme()}`]
    });
  }

  getData() {
    const items = this.state.items.map((item, index) => ({ ...item, index }));
    const players = this.state.players.map(player => ({
      ...player,
      assignedItems: items.filter(item => item.assignee === player.actorId),
    }));
    const unassignedItems = items.filter(item => !item.assignee);

    return {
      enemies: stackEnemiesForDisplay(this.state.enemies),
      players,
      items: unassignedItems,
      xp: this.state.xp,
      currency: this.state.currency,
      useXp: getUseXp()
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find(".looter-reroll").on("click", async ev => {
      ev.preventDefault();
      await this._reroll();
    });

    html.find(".looter-apply").on("click", async ev => {
      ev.preventDefault();
      await this._syncStateFromForm(html[0]);
      await grantRewards(this._payloadForApply());
      ui.notifications.info("Looter rewards applied.");
      this.render(false);
    });

    html.find(".looter-chat").on("click", async ev => {
      ev.preventDefault();
      await this._syncStateFromForm(html[0]);
      const payload = this._payloadForApply();
      payload.items = payload.items.map(item => ({ ...item, assigneeName: this.state.players.find(p => p.actorId === item.assignee)?.name || "" }));
      await ChatMessage.create({
        content: rewardsSummaryHTML(payload),
        speaker: ChatMessage.getSpeaker({ alias: "Looter" })
      });
      ui.notifications.info("Looter summary sent to chat.");
    });

    html.find(".looter-unassign-pill").on("click", ev => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.index);
      if (!Number.isFinite(idx) || !this.state.items[idx]) return;
      this.state.items[idx].assignee = "";
      this.render(false);
    });

    html.find(".looter-item-row").attr("draggable", true).on("dragstart", ev => {
      const idx = Number(ev.currentTarget.dataset.index);
      if (!Number.isFinite(idx)) return;
      ev.originalEvent.dataTransfer?.setData("text/plain", String(idx));
      ev.originalEvent.dataTransfer.effectAllowed = "move";
    });

    html.find(".looter-player-card").on("dragover", ev => {
      ev.preventDefault();
      ev.currentTarget.classList.add("is-drop-target");
      if (ev.originalEvent.dataTransfer) ev.originalEvent.dataTransfer.dropEffect = "move";
    }).on("dragleave", ev => {
      ev.currentTarget.classList.remove("is-drop-target");
    }).on("drop", ev => {
      ev.preventDefault();
      ev.currentTarget.classList.remove("is-drop-target");
      const idx = Number(ev.originalEvent.dataTransfer?.getData("text/plain"));
      const actorId = ev.currentTarget.dataset.actorId || "";
      if (!Number.isFinite(idx) || !this.state.items[idx]) return;
      this.state.items[idx].assignee = actorId;
      this.render(false);
    });

    html.find(".looter-unassigned-dropzone").on("dragover", ev => {
      ev.preventDefault();
      ev.currentTarget.classList.add("is-drop-target");
      if (ev.originalEvent.dataTransfer) ev.originalEvent.dataTransfer.dropEffect = "move";
    }).on("dragleave", ev => {
      ev.currentTarget.classList.remove("is-drop-target");
    }).on("drop", ev => {
      ev.preventDefault();
      ev.currentTarget.classList.remove("is-drop-target");
      const idx = Number(ev.originalEvent.dataTransfer?.getData("text/plain"));
      if (!Number.isFinite(idx) || !this.state.items[idx]) return;
      this.state.items[idx].assignee = "";
      this.render(false);
    });
  }

  async _syncStateFromForm(root) {
    this.state.players.forEach((player, idx) => {
      const checkbox = root.querySelector(`[name="players.${idx}.enabled"]`);
      player.enabled = checkbox ? checkbox.checked : true;
    });

    this.state.xp = clampNumber(root.querySelector('[name="xp"]')?.value, this.state.xp);
    for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
      this.state.currency[denom] = clampNumber(root.querySelector(`[name="currency.${denom}"]`)?.value, 0);
    }

  }

  async _reroll() {
    const fakeCombat = {
      id: this.snapshot.combatId,
      name: this.snapshot.combatName,
      combatants: this.snapshot.enemies.map(enemy => ({
        id: enemy.combatantId,
        defeated: true,
        actor: {
          id: enemy.actorId,
          name: enemy.name,
          img: enemy.img,
          type: "npc",
          system: { details: { cr: enemy.cr, xp: { value: enemy.xp } } }
        }
      })).concat(this.snapshot.players.map(player => ({
        id: player.combatantId,
        defeated: false,
        actor: { id: player.actorId, name: player.name, img: player.img, type: "character", hasPlayerOwner: true }
      })))
    };

    const fresh = await buildEncounterSnapshot(fakeCombat);
    this.state.xp = fresh.totals.xp;
    this.state.currency = clone(fresh.totals.currency);
    this.state.items = fresh.totals.items.map(i => ({ ...i, assignee: "" }));
    this.render(false);
  }

  _payloadForApply() {
    return {
      players: clone(this.state.players),
      xp: this.state.xp,
      currency: clone(this.state.currency),
      items: clone(this.state.items)
    };
  }


  async close(options) {
    return super.close(options);
  }

  async _updateObject(_event, _formData) {}
}

function openMonsterTableApp() {
  new LooterMonsterTableApp().render(true);
}

function openTreasureProfilesApp() {
  new LooterTreasureProfilesApp().render(true);
}

function openEncounterApp(snapshot) {
  if (!snapshot) return;
  const existing = Object.values(ui.windows || {}).find(w => w instanceof LooterEncounterApp);
  if (existing) existing.close();
  new LooterEncounterApp(snapshot).render(true);
}

function queueEncounterAppOpen(combatId, snapshot, delay = 25) {
  if (!combatId || !snapshot) return;
  const existingTimer = PENDING_OPENS.get(combatId);
  if (existingTimer) window.clearTimeout(existingTimer);

  const timer = window.setTimeout(() => {
    PENDING_OPENS.delete(combatId);
    const stored = SNAPSHOTS.get(combatId) || snapshot;
    if (!stored) return;
    SNAPSHOTS.delete(combatId);
    openEncounterApp(stored);
  }, delay);

  PENDING_OPENS.set(combatId, timer);
}

Hooks.once("init", () => {
  game.settings.register(LOOTER_ID, "monsterTable", {
    name: "Monster Table",
    hint: "Internal monster lookup table for Looter.",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(LOOTER_ID, "treasureProfiles", {
    name: "Treasure Profiles",
    hint: "Currency formulas and linked item tables for each treasure type and CR tier.",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(LOOTER_ID, "useXp", {
    name: "Award XP",
    hint: "Turn this off for milestone campaigns.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(LOOTER_ID, "theme", {
    name: "Window Theme",
    hint: "Color theme for Looter windows.",
    scope: "client",
    config: true,
    type: String,
    choices: THEME_CHOICES,
    default: "violet"
  });

  game.settings.registerMenu(LOOTER_ID, "monsterTableMenu", {
    name: "Open Monster Registry",
    label: "Monster Registry",
    hint: "Open the Looter monster registry.",
    icon: "fas fa-dragon",
    type: LooterMonsterTableApp,
    restricted: true
  });

  game.settings.registerMenu(LOOTER_ID, "treasureProfilesMenu", {
    name: "Open Treasure Profiles",
    label: "Treasure Profiles",
    hint: "Open the Looter treasure profiles manager.",
    icon: "fas fa-coins",
    type: LooterTreasureProfilesApp,
    restricted: true
  });
});

Hooks.once("ready", async () => {
  await ensureWorldTables();
  await ensureTreasureProfiles();
  game.modules.get(LOOTER_ID).api = {
    openMonsterTableApp,
    openTreasureProfilesApp,
    buildEncounterSnapshot,
    ensureWorldTables,
    ensureTreasureProfiles,
    tableName,
    profileKey,
    parseRollFormulaValue,
    findTreasureProfile
  };
});

Hooks.on("renderActorDirectory", (_app, html) => {
  if (!game.user.isGM) return;
  if (html.find(".looter-open-manager").length) return;
  const button = $(`
    <button type="button" class="looter-open-manager">
      <i class="fas fa-sack-dollar"></i> Looter
    </button>
  `);
  button.on("click", ev => {
    ev.preventDefault();
    openMonsterTableApp();
  });
  html.find(".directory-header .header-actions").append(button);
});

Hooks.on("preDeleteCombat", async combat => {
  if (!game.user.isGM) return;
  try {
    const combatId = combat?.id || combat?._id;
    const snapshot = await buildEncounterSnapshot(combat);
    if (!snapshot.enemies.length) return;
    SNAPSHOTS.set(combatId, snapshot);
    log("Snapshot stored", combatId, snapshot);
    // Fallback in case deleteCombat timing is swallowed by the end-combat flow.
    queueEncounterAppOpen(combatId, snapshot, 75);
  } catch (err) {
    console.error(`${LOOTER_ID} | Failed to snapshot combat`, err);
  }
});

Hooks.on("deleteCombat", combat => {
  if (!game.user.isGM) return;
  const combatId = combat?.id || combat?._id;
  const snapshot = SNAPSHOTS.get(combatId);
  if (!snapshot) return;
  queueEncounterAppOpen(combatId, snapshot, 0);
});
