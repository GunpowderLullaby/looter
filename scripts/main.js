const LOOTER_ID = "looter";
// Resolve the live install folder from the loaded script so template and module lookups
// still work when the on-disk folder casing does not match the manifest id.
const MODULE_ROOT_URL = new URL("../", import.meta.url);
const MODULE_FOLDER = decodeURIComponent(MODULE_ROOT_URL.pathname)
  .split("/")
  .filter(Boolean)
  .at(-1) || LOOTER_ID;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
let SETTINGS_NAMESPACE = LOOTER_ID;
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

function moduleAssetPath(relativePath) {
  return new URL(String(relativePath ?? "").replace(/^\.?\//, ""), MODULE_ROOT_URL).pathname;
}

function getLooterModule() {
  const direct = game.modules.get(LOOTER_ID);
  if (direct) return direct;

  const fallback = game.modules.get(MODULE_FOLDER)
    ?? Array.from(game.modules.values()).find(pkg => {
      const id = String(pkg?.id ?? "").toLowerCase();
      return id === LOOTER_ID || id === MODULE_FOLDER.toLowerCase();
    })
    ?? null;

  if (fallback) {
    console.warn(
      `${LOOTER_ID} | Resolved this module using install folder "${MODULE_FOLDER}". ` +
      `Rename the module folder to "${LOOTER_ID}" to match module.json and avoid V14 package lookup issues.`
    );
  }

  return fallback;
}

const LOOTER_SETTING_CONFIGS = {
  monsterTable: {
    name: "Monster Table",
    hint: "Stored monster rewards lookup table.",
    scope: "world",
    config: false,
    type: Object,
    default: []
  },
  treasureProfiles: {
    name: "Treasure Profiles",
    hint: "Currency formulas and linked item tables for each treasure type and CR tier.",
    scope: "world",
    config: false,
    type: Object,
    default: []
  },
  useXp: {
    name: "Award XP",
    hint: "Turn this off for milestone campaigns.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  },
  theme: {
    name: "Window Theme",
    hint: "Color theme for Looter windows.",
    scope: "client",
    config: true,
    type: String,
    choices: THEME_CHOICES,
    default: "violet"
  }
};

function getSettingsNamespace() {
  return SETTINGS_NAMESPACE;
}

function registerLooterSettings(namespace, { includeMenus = false, forceHidden = false } = {}) {
  for (const [key, config] of Object.entries(LOOTER_SETTING_CONFIGS)) {
    game.settings.register(namespace, key, {
      ...config,
      config: forceHidden ? false : config.config
    });
  }

  if (!includeMenus) return;

  game.settings.registerMenu(namespace, "monsterTableMenu", {
    name: "Open Monster Registry",
    label: "Monster Registry",
    hint: "Open the Looter monster registry.",
    icon: "fas fa-dragon",
    type: LooterMonsterTableApp,
    restricted: true
  });

  game.settings.registerMenu(namespace, "treasureProfilesMenu", {
    name: "Open Treasure Profiles",
    label: "Treasure Profiles",
    hint: "Open the Looter treasure profiles manager.",
    icon: "fas fa-coins",
    type: LooterTreasureProfilesApp,
    restricted: true
  });
}

function settingValueEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function migrateLegacySettingsNamespace(fromNamespace, toNamespace) {
  if (!fromNamespace || !toNamespace || fromNamespace === toNamespace) return;

  for (const [key, config] of Object.entries(LOOTER_SETTING_CONFIGS)) {
    const legacyValue = game.settings.get(fromNamespace, key);
    const currentValue = game.settings.get(toNamespace, key);
    if (settingValueEquals(legacyValue, config.default)) continue;
    if (!settingValueEquals(currentValue, config.default)) continue;
    await game.settings.set(toNamespace, key, legacyValue);
  }
}

async function syncSettingsNamespace(sourceNamespace, targetNamespace) {
  if (!sourceNamespace || !targetNamespace || sourceNamespace === targetNamespace) return;

  for (const key of Object.keys(LOOTER_SETTING_CONFIGS)) {
    const sourceValue = game.settings.get(sourceNamespace, key);
    const targetValue = game.settings.get(targetNamespace, key);
    if (settingValueEquals(sourceValue, targetValue)) continue;
    await game.settings.set(targetNamespace, key, sourceValue);
  }
}

async function normalizeStructuredSettings(namespace) {
  if (!namespace) return;

  for (const key of ["monsterTable", "treasureProfiles"]) {
    const stored = game.settings.get(namespace, key);
    const normalized = normalizeSettingArray(stored);
    if (settingValueEquals(stored, normalized)) continue;
    await game.settings.set(namespace, key, normalized);
  }
}

function clone(data) {
  return foundry.utils.deepClone(data);
}

function normalizeSettingArray(value) {
  let current = clone(value ?? []);

  while (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
    current = current[0];
  }

  if (Array.isArray(current)) return current;

  if (current && typeof current === "object") {
    const numericKeys = Object.keys(current)
      .filter(key => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length) return numericKeys.map(key => current[key]);
  }

  return [];
}

function getEventTargetElement(event) {
  const target = event?.target;
  if (target && typeof target.closest === "function") return target;
  return target?.parentElement ?? null;
}

function normalizeMonsterRow(row = {}) {
  return {
    name: String(row?.name ?? "").trim(),
    cr: clampNumber(row?.cr, 0),
    xp: clampNumber(row?.xp, 0),
    treasureTypes: Array.isArray(row?.treasureTypes)
      ? row.treasureTypes.map(titleCase).filter(Boolean)
      : treasureTypesFromString(row?.treasureTypes ?? "")
  };
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
    const aName = String(a?.name ?? "").trim();
    const bName = String(b?.name ?? "").trim();
    const aBlank = !aName;
    const bBlank = !bName;
    if (aBlank !== bBlank) return aBlank ? 1 : -1;

    if (field === "cr") {
      const diff = clampNumber(a?.cr, 0) - clampNumber(b?.cr, 0);
      if (diff !== 0) return diff * factor;
      return aName.localeCompare(bName, undefined, { sensitivity: "base" }) * factor;
    }
    const diff = aName.localeCompare(bName, undefined, { sensitivity: "base" });
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
  return game.settings.get(getSettingsNamespace(), "theme") || "violet";
}

function getUseXp() {
  return game.settings.get(getSettingsNamespace(), "useXp") !== false;
}

function getMonsterTable() {
  return normalizeSettingArray(game.settings.get(getSettingsNamespace(), "monsterTable"));
}

async function setMonsterTable(rows) {
  await game.settings.set(getSettingsNamespace(), "monsterTable", normalizeSettingArray(rows));
}

function getTreasureProfiles() {
  return normalizeSettingArray(game.settings.get(getSettingsNamespace(), "treasureProfiles"));
}

async function setTreasureProfiles(rows) {
  await game.settings.set(getSettingsNamespace(), "treasureProfiles", normalizeSettingArray(rows));
}

function defaultCurrencyBlock() {
  return { pp: "", gp: "", ep: "", sp: "", cp: "" };
}

function zeroCurrencyTotals() {
  return { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
}

function addCurrencyTotals(target, source, factor = 1) {
  for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
    target[denom] = clampNumber(target[denom], 0) + (clampNumber(source?.[denom], 0) * factor);
  }
  return target;
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
  const hasItemTable = Object.prototype.hasOwnProperty.call(row ?? {}, "itemTable");
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
    itemTable: hasItemTable ? normalized.itemTable : (starter.itemTable || "")
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

function buildRollTableReference({ pack = "", id = "", documentName = "RollTable" } = {}) {
  const packName = String(pack ?? "").trim();
  const docId = String(id ?? "").trim();
  if (!packName || !docId) return "";
  return foundry.utils?.buildUuid?.({ pack: packName, documentName, id: docId })
    || `Compendium.${packName}.${documentName}.${docId}`;
}

function parseCompendiumRollTableReference(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref.startsWith("Compendium.")) return null;

  const parts = ref.split(".");
  if (parts.length < 4) return null;

  const id = parts.at(-1) || "";
  const maybeDocumentName = parts.at(-2) || "";
  const hasDocumentName = maybeDocumentName === "RollTable";
  const pack = parts.slice(1, hasDocumentName ? -2 : -1).join(".");

  if (!pack || !id) return null;
  return { pack, id };
}

function getCompendiumCollectionKey(pack) {
  return String(pack?.collection || pack?.metadata?.id || "").trim();
}

function getCompendiumPackLabel(pack) {
  return String(pack?.metadata?.label || pack?.title || getCompendiumCollectionKey(pack)).trim();
}

function getCompendiumIndexEntries(pack) {
  const index = pack?.index;
  if (!index) return [];
  if (Array.isArray(index)) return index;
  if (typeof index.values === "function") return Array.from(index.values());
  if (Array.isArray(index.contents)) return index.contents;
  return [];
}

function getCompendiumIndexEntry(pack, id) {
  const docId = String(id ?? "").trim();
  if (!pack || !docId) return null;
  if (typeof pack.index?.get === "function") return pack.index.get(docId) ?? null;
  return getCompendiumIndexEntries(pack).find(entry => String(entry?._id || entry?.id || "").trim() === docId) ?? null;
}

function getRollTableReference(table) {
  if (!table) return "";
  return table.uuid || (table.pack ? buildRollTableReference({ pack: table.pack, id: table.id, documentName: table.documentName || "RollTable" }) : `RollTable.${table.id}`);
}

function findRollTableByReference(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return null;
  if (ref.includes(".") && typeof foundry.utils?.fromUuidSync === "function") {
    try {
      const resolved = foundry.utils.fromUuidSync(ref);
      if (resolved?.documentName === "RollTable" || (parseCompendiumRollTableReference(ref) && resolved?.name)) return resolved;
    } catch (_err) {}
  }
  if (/^RollTable\./.test(ref)) {
    const id = ref.split(".")[1] || "";
    return game.tables.get(id) ?? null;
  }
  const compendiumRef = parseCompendiumRollTableReference(ref);
  if (compendiumRef) {
    const pack = game.packs.get(compendiumRef.pack);
    if (pack?.documentName !== "RollTable") return null;
    const entry = getCompendiumIndexEntry(pack, compendiumRef.id);
    return entry
      ? { ...entry, pack: compendiumRef.pack, uuid: buildRollTableReference({ pack: compendiumRef.pack, id: compendiumRef.id }) || ref }
      : { pack: compendiumRef.pack, id: compendiumRef.id, uuid: ref, name: ref };
  }
  return game.tables.find(t => t.name === ref) ?? null;
}

async function resolveRollTableByReference(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return null;
  const compendiumRef = parseCompendiumRollTableReference(ref);
  if (compendiumRef) {
    const canonicalRef = buildRollTableReference({ pack: compendiumRef.pack, id: compendiumRef.id }) || ref;
    try {
      const doc = await fromUuid(canonicalRef);
      if (doc?.documentName === "RollTable") return doc;
    } catch (err) {
      console.warn(`${LOOTER_ID} | Failed to resolve roll table by UUID`, canonicalRef, err);
    }

    try {
      const pack = game.packs.get(compendiumRef.pack);
      const doc = await pack?.getDocument?.(compendiumRef.id);
      if (doc?.documentName === "RollTable") return doc;
    } catch (err) {
      console.warn(`${LOOTER_ID} | Failed to resolve roll table from compendium`, compendiumRef, err);
    }
  }
  return findRollTableByReference(ref);
}

function getRollTableDisplayName(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) return "";
  const table = findRollTableByReference(ref);
  const compendiumRef = parseCompendiumRollTableReference(ref);
  if (compendiumRef) {
    const pack = game.packs.get(compendiumRef.pack);
    const packLabel = getCompendiumPackLabel(pack) || compendiumRef.pack;
    const name = String(table?.name || getCompendiumIndexEntry(pack, compendiumRef.id)?.name || "").trim();
    if (name && packLabel) return `${name} (${packLabel})`;
    return name || packLabel || ref;
  }
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
  const sourceTable = await resolveRollTableByReference(ref);
  let table = sourceTable;
  if (sourceTable?.pack) {
    try {
      table = await sourceTable.clone({}, { save: false, keepId: true, pack: null, parentCollection: null });
    } catch (err) {
      console.warn(`${LOOTER_ID} | Failed to clone compendium roll table for drawing`, ref, err);
      table = sourceTable;
    }
  }
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
  const data = getDragEventData(dragEvent);

  if (!data) return null;

  try {
    if (typeof Actor?.fromDropData === "function") {
      const actor = await Actor.fromDropData(data);
      if (actor?.documentName === "Actor") return actor;
    }

    for (const uuid of getDroppedDocumentUuids(data, "Actor")) {
      const doc = await fromUuid(uuid);
      if (doc?.documentName === "Actor") return doc;
    }

    const type = String(data.type ?? data.documentName ?? data.documentType ?? "").trim();
    const id = String(data.id ?? data._id ?? data.documentId ?? data.entryId ?? "").trim();
    if ((type === "Actor" || !type) && id) {
      return game.actors.get(id) ?? null;
    }
  } catch (err) {
    console.warn(`${LOOTER_ID} | Failed to resolve dropped actor`, err, data);
  }

  return null;
}

function getDragEventData(event) {
  const dragEvent = event?.originalEvent ?? event;
  const textEditor = foundry.applications?.ux?.TextEditor?.implementation
    ?? foundry.applications?.ux?.TextEditor
    ?? globalThis.TextEditor;

  if (typeof textEditor?.getDragEventData === "function") {
    try {
      const data = textEditor.getDragEventData(dragEvent);
      const hasPayload = data
        && (typeof data !== "object"
          || Array.isArray(data)
          || Object.keys(data).length > 0);
      if (hasPayload) return data;
    } catch (_err) {}
  }

  const dataTransfer = dragEvent?.dataTransfer;
  if (!dataTransfer) return null;

  for (const mimeType of ["application/json", "text/plain", "text"]) {
    const raw = String(dataTransfer.getData(mimeType) ?? "").trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_err) {}

    if (/@UUID\[([^\]]+)\]/.test(raw)) return { uuid: raw.match(/@UUID\[([^\]]+)\]/)?.[1] ?? "" };
    if (/^(Actor|RollTable)\.[A-Za-z0-9]+$/.test(raw) || /^Compendium\.[^.]+\.[^.]+\.[^.]+\.[A-Za-z0-9]+$/.test(raw)) {
      return { uuid: raw };
    }
  }

  return null;
}

function getDragDropControllerClass() {
  return CONFIG?.ux?.DragDrop
    ?? foundry.applications?.ux?.DragDrop
    ?? globalThis.DragDrop
    ?? null;
}

function getDroppedDocumentUuids(data, documentName) {
  const uuids = new Set();
  const expected = String(documentName ?? "").trim();
  const type = String(data?.type ?? data?.documentName ?? data?.documentType ?? "").trim();
  const id = String(data?.id ?? data?._id ?? data?.documentId ?? data?.entryId ?? "").trim();
  let pack = String(data?.pack ?? data?.packName ?? data?.collection ?? data?.compendium ?? "").trim();
  if (pack.startsWith("Compendium.")) pack = pack.slice("Compendium.".length);

  const uuid = String(data?.uuid ?? data?.documentUuid ?? "").trim();
  if (uuid) uuids.add(uuid);

  if (pack && id) {
    if (expected) uuids.add(`Compendium.${pack}.${expected}.${id}`);
    if (type) uuids.add(`Compendium.${pack}.${type}.${id}`);
  }

  if (id && expected) uuids.add(`${expected}.${id}`);
  return [...uuids].filter(Boolean);
}

async function resolveDroppedRollTable(event) {
  const dragEvent = event?.originalEvent ?? event;
  const data = getDragEventData(dragEvent);

  if (!data) return null;

  try {
    for (const uuid of getDroppedDocumentUuids(data, "RollTable")) {
      const doc = await fromUuid(uuid);
      if (doc?.documentName === "RollTable") {
        const reference = getRollTableReference(doc);
        return { table: doc, reference };
      }
    }

    const type = String(data.type ?? data.documentName ?? data.documentType ?? "").trim();
    const isRollTable = type === "RollTable";
    if (!isRollTable) return null;

    const id = String(data.id ?? data._id ?? data.documentId ?? data.entryId ?? "").trim();
    if (!id) return null;

    let pack = String(data.pack ?? data.packName ?? data.collection ?? "").trim();
    if (pack.startsWith("Compendium.")) pack = pack.slice("Compendium.".length);

    const reference = pack ? buildRollTableReference({ pack, id }) : `RollTable.${id}`;
    const table = await resolveRollTableByReference(reference);
    return { table, reference: table ? getRollTableReference(table) || reference : reference };
  } catch (err) {
    console.warn(`${LOOTER_ID} | Failed to resolve dropped roll table`, err, data);
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

  const totalCurrency = zeroCurrencyTotals();
  let totalXp = 0;
  const lootItems = [];

  for (const combatant of getDefeatedCombatants(combat)) {
    const actor = combatant.actor;
    const fallbackCr = clampNumber(foundry.utils.getProperty(actor, "system.details.cr"), 0);
    const fallbackXp = clampNumber(foundry.utils.getProperty(actor, "system.details.xp.value"), 0);
    const matched = findMonsterEntryByName(actor?.name);
    const entry = matched ?? { name: actor?.name ?? combatant.name, cr: fallbackCr, xp: fallbackXp, treasureTypes: [] };

    const rolled = await rollFromTreasurePlan(entry);
    const rewardItems = rolled.items.map(item => clone(item));

    enemies.push({
      combatantId: combatant.id,
      actorId: actor?.id,
      name: actor?.name ?? combatant.name,
      img: actor?.img ?? "icons/svg/mystery-man.svg",
      cr: clampNumber(entry.cr, fallbackCr),
      xp: clampNumber(entry.xp, fallbackXp),
      treasureTypes: Array.isArray(entry.treasureTypes) ? [...entry.treasureTypes] : [],
      matched: Boolean(matched),
      rewards: {
        currency: clone(rolled.currency),
        items: rewardItems
      }
    });

    totalXp += clampNumber(entry.xp, fallbackXp);
    addCurrencyTotals(totalCurrency, rolled.currency);
    lootItems.push(...rewardItems.map(item => clone(item)));
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
  const xpHtml = getUseXp() ? `<p><strong>XP:</strong> ${payload.xp}</p>` : "";
  return `
  <div class="looter-chat-summary">
    <h3>Looter Rewards</h3>
    <p><strong>Recipients:</strong> ${playerNames}</p>
    ${xpHtml}
    <p><strong>Currency:</strong> ${currencyBits}</p>
    <ul>${loot || "<li>No items</li>"}</ul>
  </div>`;
}

async function rewardsSummaryChatHTML(payload) {
  const playerNames = payload.players.filter(p => p.enabled).map(p => p.name).join(", ") || "No one";
  const textEditor = foundry.applications?.ux?.TextEditor?.implementation;
  const loot = await Promise.all(payload.items.map(async item => {
    const safeName = foundry.utils.escapeHTML(String(item?.name ?? "").trim() || "Loot");
    const safeAssignee = foundry.utils.escapeHTML(String(item?.assigneeName ?? "").trim());
    const suffix = safeAssignee ? ` &rarr; ${safeAssignee}` : "";
    const sourceUuid = String(item?.sourceUuid ?? "").trim();
    if (!sourceUuid || typeof textEditor?.enrichHTML !== "function") return `<li>${safeName}${suffix}</li>`;

    const enrichedLink = await textEditor.enrichHTML(`@UUID[${sourceUuid}]{${safeName}}`, {
      documents: true,
      links: true,
      embeds: false,
      rolls: false,
      secrets: false
    });
    return `<li>${enrichedLink}${suffix}</li>`;
  }));
  const currencyBits = ["pp", "gp", "ep", "sp", "cp"].map(d => `${payload.currency[d] ?? 0} ${d}`).join(", ");
  const xpHtml = getUseXp() ? `<p><strong>XP:</strong> ${payload.xp}</p>` : "";
  return `
  <div class="looter-chat-summary">
    <h3>Looter Rewards</h3>
    <p><strong>Recipients:</strong> ${foundry.utils.escapeHTML(playerNames)}</p>
    ${xpHtml}
    <p><strong>Currency:</strong> ${currencyBits}</p>
    <ul>${loot.join("") || "<li>No items</li>"}</ul>
  </div>`;
}

function stackEnemiesForDisplay(enemies = []) {
  const groups = new Map();

  enemies.forEach((enemy, index) => {
    const key = [normalizeName(enemy.name), String(enemy.cr), String(enemy.xp), (enemy.treasureTypes || []).join("|")].join("::");
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalXp += clampNumber(enemy.xp, 0);
      existing.memberIndexes.push(index);
      return;
    }

    groups.set(key, {
      ...enemy,
      count: 1,
      totalXp: clampNumber(enemy.xp, 0),
      memberIndexes: [index]
    });
  });

  return Array.from(groups.values()).map(enemy => ({
    ...enemy,
    isStacked: enemy.count > 1,
    displayName: enemy.count > 1 ? `${enemy.name} x${enemy.count}` : enemy.name,
    memberIndexCsv: enemy.memberIndexes.join(",")
  }));
}

class LooterApplicationV2 extends HandlebarsApplicationMixin(ApplicationV2) {
  static get DEFAULT_OPTIONS() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      classes: ["looter-app"],
      window: {
        frame: true,
        positioned: true,
        resizable: true
      }
    }, { inplace: false });
  }

  get bodyElement() {
    return (this._bodyPartElement?.isConnected ? this._bodyPartElement : null)
      ?? this.element?.querySelector?.(".looter-shell")
      ?? this.parts.body
      ?? this.element;
  }

  get interactionElement() {
    return this.window?.content
      ?? this.element
      ?? this.bodyElement;
  }

  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId === "body") this._bodyPartElement = htmlElement;
  }

  _findDropzoneByPoint(selector, event, root = this.bodyElement ?? this.element) {
    if (!selector || !root?.querySelectorAll) return null;
    const dragEvent = event?.originalEvent ?? event;
    const x = Number(dragEvent?.clientX);
    const y = Number(dragEvent?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    for (const zone of root.querySelectorAll(selector)) {
      const rect = zone.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return zone;
    }

    return null;
  }

  _findDropzoneFromEvent(selector, event, root = this.bodyElement ?? this.element) {
    if (!selector) return null;
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (node?.matches?.(selector)) return node;
      if (node?.closest?.(selector)) return node.closest(selector);
    }

    return this._findDropzoneByPoint(selector, event, root)
      ?? getEventTargetElement(event)?.closest?.(selector)
      ?? null;
  }

  _bindAppDragDropController({ selector, callbacks = {}, fallbackElement = null } = {}) {
    const DragDropController = getDragDropControllerClass();
    const bindElement = fallbackElement ?? this.interactionElement;
    if (typeof DragDropController !== "function" || !selector || !bindElement?.addEventListener) return;
    if (this._dragDrop && this._dragDropBoundElement === bindElement && this._dragDropSelector === selector) return;

    this._dragDrop = new DragDropController({
      dropSelector: selector,
      permissions: {
        drop: () => true
      },
      callbacks
    });
    this._dragDrop.bind(bindElement);
    this._dragDropBoundElement = bindElement;
    this._dragDropSelector = selector;
  }

  async _runLooterAction(operation, logContext, userMessage) {
    try {
      return await operation();
    } catch (err) {
      console.error(`${LOOTER_ID} | ${logContext}`, err);
      if (userMessage) ui.notifications.error(userMessage);
      return undefined;
    }
  }
}

class LooterMonsterTableApp extends LooterApplicationV2 {
  constructor(options = {}) {
    super(options);
    this._monsterSort = { field: "name", direction: "asc" };
    this._draftRows = sortMonsterRows(getMonsterTable().map(normalizeMonsterRow), this._monsterSort);
    this._pendingFocusRowIndex = null;
    this._bodyListenersAbort = null;
    this._activeMonsterDropzone = null;
    this._dragDrop = null;
    this._dragDropBoundElement = null;
    this._dragDropSelector = null;
    this._typePopover = null;
    this._boundDocumentPointerDown = this._onDocumentPointerDown.bind(this);
    this._boundWindowResize = this._repositionTypePopover.bind(this);
  }

  static get DEFAULT_OPTIONS() {
    const options = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "looter-monster-table",
      position: {
        width: 1280,
        height: 820
      },
      window: {
        title: "Monster Registry"
      }
    }, { inplace: false });
    options.classes = [...(options.classes ?? []), `theme-${getTheme()}`];
    return options;
  }

  static get PARTS() {
    return {
      body: {
        template: moduleAssetPath("templates/monster-table.html"),
        root: true,
        scrollable: [".looter-manager-table-wrap"]
      }
    };
  }

  async _prepareContext(_options) {
    const rows = this._draftRows.map((row, index) => {
      const normalized = normalizeMonsterRow(row);
      return {
        ...normalized,
        index,
        treasureTypesValue: normalized.treasureTypes.join(", ")
      };
    });

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

  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId !== "body") return;

    this._bindMonsterDragDropController(htmlElement);
  }

  _bindMonsterDragDropController(fallbackElement = null) {
    this._bindAppDragDropController({
      selector: "[data-import-dropzone], [data-import-dropzone] *",
      fallbackElement,
      callbacks: {
        dragenter: event => {
          const zone = this._findMonsterDropzoneFromEvent(event);
          if (zone) this._onMonsterDropOver(event, zone);
        },
        dragover: event => {
          const zone = this._findMonsterDropzoneFromEvent(event);
          if (zone) this._onMonsterDropOver(event, zone);
        },
        dragleave: event => {
          const zone = this._findMonsterDropzoneFromEvent(event) ?? this._activeMonsterDropzone;
          if (!zone) return;
          const next = event.relatedTarget;
          if (next && zone.contains?.(next)) return;
          this._onMonsterDropLeave(event, zone);
        },
        drop: event => {
          const zone = this._findMonsterDropzoneFromEvent(event) ?? this._activeMonsterDropzone;
          if (zone) void this._onMonsterImportDrop(event, zone);
        }
      }
    });
  }

  _onClickAction(event, target) {
    const action = target.dataset.action;
    switch (action) {
      case "openProfiles":
        event.preventDefault();
        openTreasureProfilesApp();
        return;
      case "saveRows":
        event.preventDefault();
        void this._runLooterAction(
          () => this._saveFromForm(),
          "Monster Registry action failed",
          "Looter couldn't save the Monster Registry."
        );
        return;
      case "addRow":
        event.preventDefault();
        void this._runLooterAction(
          () => this._addDraftRow(),
          "Monster Registry action failed",
          "Looter couldn't add a monster row."
        );
        return;
      case "sortRows":
        event.preventDefault();
        void this._runLooterAction(
          () => this._sortDraftRows(String(target.dataset.field || "name")),
          "Monster Registry action failed",
          "Looter couldn't sort the Monster Registry."
        );
        return;
      case "toggleTreasureTypes":
        event.preventDefault();
        this._toggleTypePopover(target);
        return;
      case "deleteRow":
        event.preventDefault();
        void this._runLooterAction(
          () => this._deleteDraftRow(Number(target.dataset.index)),
          "Monster Registry action failed",
          "Looter couldn't remove that monster row."
        );
        return;
      default:
        return super._onClickAction(event, target);
    }
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._bindMonsterDragDropController();
    this._bindMonsterBodyListeners();

    const index = this._pendingFocusRowIndex;
    if (!Number.isFinite(index)) return;
    this._pendingFocusRowIndex = null;

    requestAnimationFrame(() => {
      const input = this.bodyElement?.querySelector(`[name="rows.${index}.name"]`);
      input?.closest?.("tr")?.scrollIntoView?.({ block: "nearest" });
      input?.focus?.();
      input?.select?.();
    });
  }

  _bindMonsterBodyListeners() {
    this._bodyListenersAbort?.abort();
    const root = this.bodyElement ?? this.element;
    if (!root?.addEventListener) return;
    const controller = new AbortController();
    const listenerOptions = { signal: controller.signal };
    const captureOptions = { capture: true, signal: controller.signal };
    const doc = root.ownerDocument;
    root.addEventListener("input", this._onMonsterFieldInput.bind(this), listenerOptions);
    root.addEventListener("change", this._onMonsterFieldInput.bind(this), listenerOptions);
    root.addEventListener("dragenter", this._onMonsterBodyDragOver.bind(this), captureOptions);
    root.addEventListener("dragover", this._onMonsterBodyDragOver.bind(this), captureOptions);
    root.addEventListener("dragleave", this._onMonsterBodyDragLeave.bind(this), captureOptions);
    root.addEventListener("drop", this._onMonsterBodyDrop.bind(this), captureOptions);
    const zone = root.querySelector?.("[data-import-dropzone]");
    if (zone) {
      const targets = [zone, ...zone.querySelectorAll("*")];
      for (const target of targets) {
        target.addEventListener("dragenter", event => this._onMonsterDropOver(event, zone), captureOptions);
        target.addEventListener("dragover", event => this._onMonsterDropOver(event, zone), captureOptions);
        target.addEventListener("dragleave", event => {
          const next = event.relatedTarget;
          if (next && zone.contains(next)) return;
          this._onMonsterDropLeave(event, zone);
        }, captureOptions);
        target.addEventListener("drop", event => {
          void this._onMonsterImportDrop(event, zone);
        }, captureOptions);
      }
    }
    doc?.addEventListener("dragenter", this._onMonsterDocumentDrag.bind(this), captureOptions);
    doc?.addEventListener("dragover", this._onMonsterDocumentDrag.bind(this), captureOptions);
    doc?.addEventListener("dragleave", this._onMonsterDocumentDragLeave.bind(this), captureOptions);
    doc?.addEventListener("drop", this._onMonsterDocumentDrop.bind(this), captureOptions);
    this._bodyListenersAbort = controller;
  }

  _updateDraftRowFromField(field) {
    const row = field?.closest?.("tr[data-index]");
    const index = Number(row?.dataset.index);
    if (!Number.isFinite(index)) return;

    const name = String(field.name || "");
    const current = normalizeMonsterRow(this._draftRows[index] || {});
    if (name.endsWith(".name")) current.name = String(field.value ?? "").trim();
    else if (name.endsWith(".cr")) current.cr = clampNumber(field.value, 0);
    else if (name.endsWith(".xp")) current.xp = clampNumber(field.value, 0);
    else if (name.endsWith(".treasureTypes")) current.treasureTypes = treasureTypesFromString(field.value);
    else return;

    this._draftRows[index] = normalizeMonsterRow(current);
  }

  _onMonsterFieldInput(event) {
    const target = getEventTargetElement(event);
    if (!target?.matches?.('input[name^="rows."]')) return;
    this._updateDraftRowFromField(target);
  }

  _collectMonsterRows(root = this.bodyElement, { includeBlank = false } = {}) {
    const rows = [];
    for (const row of root?.querySelectorAll?.("tbody.looter-monsters tr[data-index]") ?? []) {
      const normalized = normalizeMonsterRow({
        name: row.querySelector('input[name$=".name"]')?.value,
        cr: row.querySelector('input[name$=".cr"]')?.value,
        xp: row.querySelector('input[name$=".xp"]')?.value,
        treasureTypes: row.querySelector('input[name$=".treasureTypes"]')?.value
      });
      if (!includeBlank && !normalized.name) continue;
      rows.push(normalized);
    }
    return rows;
  }

  _syncDraftRowsFromRenderedInputs(root = this.bodyElement, { includeBlank = true } = {}) {
    if (!root && !this.element) return this._draftRows;
    const primaryRoot = root || this.element;
    let rows = this._collectMonsterRows(primaryRoot, { includeBlank });
    if (!rows.length && this.element && primaryRoot !== this.element) {
      rows = this._collectMonsterRows(this.element, { includeBlank });
    }
    this._draftRows = rows;
    return this._draftRows;
  }

  async _sortDraftRows(field) {
    this._syncDraftRowsFromRenderedInputs();
    if (this._monsterSort.field === field) this._monsterSort.direction = this._monsterSort.direction === "asc" ? "desc" : "asc";
    else this._monsterSort = { field, direction: "asc" };
    this._draftRows = sortMonsterRows(this._draftRows, this._monsterSort);
    await this.render({ force: true });
  }

  async _addDraftRow() {
    this._syncDraftRowsFromRenderedInputs();
    this._draftRows.push(normalizeMonsterRow());
    this._draftRows = sortMonsterRows(this._draftRows, this._monsterSort);
    this._pendingFocusRowIndex = Math.max(this._draftRows.length - 1, 0);
    await this.render({ force: true });
  }

  async _deleteDraftRow(index) {
    this._syncDraftRowsFromRenderedInputs();
    if (!Number.isFinite(index) || !this._draftRows[index]) return;
    this._draftRows.splice(index, 1);
    await this.render({ force: true });
  }

  _readRowTreasureTypes(row) {
    const input = row?.querySelector('input[name$=".treasureTypes"]');
    return treasureTypesFromString(input?.value || "");
  }

  _writeRowTreasureTypes(row, types) {
    const normalized = [...new Set((types || []).map(titleCase).filter(Boolean))];
    const input = row?.querySelector('input[name$=".treasureTypes"]');
    if (input) input.value = normalized.join(", ");

    const index = Number(row?.dataset?.index);
    if (Number.isFinite(index) && this._draftRows[index]) {
      this._draftRows[index].treasureTypes = normalized;
    }
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
    const target = getEventTargetElement(event);
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

  _setActiveMonsterDropzone(zone) {
    if (this._activeMonsterDropzone && this._activeMonsterDropzone !== zone) {
      this._setMonsterDropState(this._activeMonsterDropzone, false);
    }
    this._activeMonsterDropzone = zone || null;
    if (zone) this._setMonsterDropState(zone, true);
  }

  _findMonsterDropzoneByPoint(event) {
    return this._findDropzoneByPoint("[data-import-dropzone]", event);
  }

  _findMonsterDropzoneFromEvent(event) {
    return this._findDropzoneFromEvent("[data-import-dropzone]", event);
  }

  _onMonsterDocumentDrag(event) {
    const zone = this._findMonsterDropzoneByPoint(event);
    if (!zone) {
      this._setActiveMonsterDropzone(null);
      return;
    }
    this._setActiveMonsterDropzone(zone);
    this._onMonsterDropOver(event, zone);
  }

  _onMonsterDocumentDragLeave(event) {
    const zone = this._findMonsterDropzoneByPoint(event);
    if (zone) return;
    this._setActiveMonsterDropzone(null);
  }

  _onMonsterDocumentDrop(event) {
    const zone = this._findMonsterDropzoneByPoint(event);
    this._setActiveMonsterDropzone(null);
    if (!zone) return;
    void this._onMonsterImportDrop(event, zone);
  }

  _onMonsterBodyDragOver(event) {
    const zone = this._findMonsterDropzoneFromEvent(event);
    if (!zone) return;
    this._onMonsterDropOver(event, zone);
  }

  _onMonsterBodyDragLeave(event) {
    const zone = this._findMonsterDropzoneFromEvent(event);
    if (!zone) return;
    const next = event.relatedTarget;
    if (next && zone.contains(next)) return;
    this._onMonsterDropLeave(event, zone);
  }

  _onMonsterBodyDrop(event) {
    const zone = this._findMonsterDropzoneFromEvent(event);
    if (!zone) return;
    void this._onMonsterImportDrop(event, zone);
  }

  _onMonsterDropOver(event, target = event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    this._setMonsterDropState(target, true);
    if ((event.originalEvent ?? event).dataTransfer) (event.originalEvent ?? event).dataTransfer.dropEffect = "copy";
  }

  _onMonsterDropLeave(event, target = event.currentTarget) {
    event.stopPropagation();
    this._setMonsterDropState(target, false);
  }

  async _importActorToRows(event, target = event.currentTarget) {
    const dragEvent = event?.originalEvent ?? event;
    if (dragEvent?._looterMonsterDropHandled) return;
    if (dragEvent) dragEvent._looterMonsterDropHandled = true;

    event.preventDefault();
    event.stopPropagation();
    this._setActiveMonsterDropzone(null);
    this._setMonsterDropState(target, false);

    const actor = await resolveDroppedActor(event);
    if (!actor) {
      ui.notifications.warn("Drop an Actor into the Looter import area.");
      return;
    }
    if (actor.type !== "npc") {
      ui.notifications.warn("Only NPC actors can be imported into Looter.");
      return;
    }

    this._syncDraftRowsFromRenderedInputs();
    const imported = normalizeMonsterRow(monsterRowFromActor(actor));
    if (!imported.name) return;

    const existingIndex = this._draftRows.findIndex(row => normalizeName(row.name) === normalizeName(imported.name));
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

      this._draftRows[existingIndex] = imported;
      this._draftRows = sortMonsterRows(this._draftRows, this._monsterSort);
      ui.notifications.info(`Looter updated ${imported.name} in the draft registry. Click Save to persist.`);
      await this.render({ force: true });
      return;
    }

    this._draftRows.push(imported);
    this._draftRows = sortMonsterRows(this._draftRows, this._monsterSort);
    ui.notifications.info(`Looter imported ${imported.name} into the draft registry. Click Save to persist.`);
    await this.render({ force: true });
  }

  async _onMonsterImportDrop(event, target = event.currentTarget) {
    await this._runLooterAction(
      () => this._importActorToRows(event, target),
      "Monster import failed",
      "Looter couldn't import that actor."
    );
  }

  async _saveFromForm() {
    this._syncDraftRowsFromRenderedInputs();
    const rows = this._draftRows
      .map(normalizeMonsterRow)
      .filter(row => row.name);
    if (!rows.length) {
      const rawNames = Array.from(this.element?.querySelectorAll?.('tbody.looter-monsters input[name$=".name"]') ?? [])
        .map(input => String(input?.value ?? "").trim())
        .filter(Boolean);
      if (rawNames.length) {
        console.warn(`${LOOTER_ID} | Monster Registry save found visible names but no collected rows.`, {
          rawNames,
          bodyElement: this.bodyElement,
          element: this.element
        });
      }
    }
    await setMonsterTable(rows);
    this._draftRows = sortMonsterRows(rows, this._monsterSort);
    ui.notifications.info("Looter monster registry saved.");
    await this.render({ force: true });
  }

  async _preClose(options) {
    this._bodyListenersAbort?.abort();
    this._bodyListenersAbort = null;
    this._activeMonsterDropzone = null;
    this._dragDrop = null;
    this._dragDropBoundElement = null;
    this._dragDropSelector = null;
    this._closeTypePopover();
    return super._preClose(options);
  }
}


class LooterTreasureProfilesApp extends LooterApplicationV2 {
  constructor(options = {}) {
    super(options);
    this._draftProfiles = getTreasureProfiles().map(normalizeProfile);
    this._pendingFocusProfileIndex = null;
    this._bodyListenersAbort = null;
    this._activeTableDropzone = null;
    this._dragDrop = null;
    this._dragDropBoundElement = null;
    this._dragDropSelector = null;
  }

  static get DEFAULT_OPTIONS() {
    const options = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "looter-treasure-profiles",
      position: {
        width: 1280,
        height: 820
      },
      window: {
        title: "Treasure Profiles"
      }
    }, { inplace: false });
    options.classes = [...(options.classes ?? []), `theme-${getTheme()}`];
    return options;
  }

  static get PARTS() {
    return {
      body: {
        template: moduleAssetPath("templates/treasure-profiles.html"),
        root: true,
        scrollable: [".looter-profile-scroll-wrap"]
      }
    };
  }

  async _prepareContext(_options) {
    return {
      profiles: this._draftProfiles.map((profile, index) => {
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

  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId !== "body") return;

    this._bindProfileDragDropController(htmlElement);
  }

  _bindProfileDragDropController(fallbackElement = null) {
    this._bindAppDragDropController({
      selector: ".looter-table-dropzone[data-index], .looter-table-dropzone[data-index] *",
      fallbackElement,
      callbacks: {
        dragenter: event => {
          const zone = this._findTableDropzoneFromEvent(event);
          if (zone) this._onTableLinkDragOver(event, zone);
        },
        dragover: event => {
          const zone = this._findTableDropzoneFromEvent(event);
          if (zone) this._onTableLinkDragOver(event, zone);
        },
        dragleave: event => {
          const zone = this._findTableDropzoneFromEvent(event) ?? this._activeTableDropzone;
          if (!zone) return;
          const next = event.relatedTarget;
          if (next && zone.contains?.(next)) return;
          this._onTableLinkDragLeave(event, zone);
        },
        drop: event => {
          const zone = this._findTableDropzoneFromEvent(event) ?? this._activeTableDropzone;
          if (zone) void this._onTableLinkDrop(event, zone);
        }
      }
    });
  }

  _onClickAction(event, target) {
    const action = target.dataset.action;
    switch (action) {
      case "openMonsters":
        event.preventDefault();
        openMonsterTableApp();
        return;
      case "addProfile":
        event.preventDefault();
        void this._runLooterAction(
          () => this._addDraftProfile(),
          "Treasure Profiles action failed",
          "Looter couldn't add a treasure profile."
        );
        return;
      case "deleteProfile":
        event.preventDefault();
        void this._runLooterAction(
          () => this._deleteDraftProfile(Number(target.dataset.index)),
          "Treasure Profiles action failed",
          "Looter couldn't remove that treasure profile."
        );
        return;
      case "saveProfiles":
        event.preventDefault();
        void this._runLooterAction(
          () => this._saveFromForm(),
          "Treasure Profiles action failed",
          "Looter couldn't save the Treasure Profiles."
        );
        return;
      case "seedTables":
        event.preventDefault();
        void this._runLooterAction(
          async () => {
            await ensureWorldTables();
            ui.notifications.info("Looter starter item tables are ready in the Roll Tables directory.");
          },
          "Treasure Profiles action failed",
          "Looter couldn't seed the starter item tables."
        );
        return;
      case "seedProfiles":
        event.preventDefault();
        void this._runLooterAction(
          () => this._seedProfiles(),
          "Treasure Profiles action failed",
          "Looter couldn't seed the starter treasure profiles."
        );
        return;
      case "clearTable":
        event.preventDefault();
        void this._runLooterAction(
          () => this._clearLinkedTable(Number(target.dataset.index)),
          "Treasure Profiles action failed",
          "Looter couldn't clear the linked RollTable."
        );
        return;
      default:
        return super._onClickAction(event, target);
    }
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._bindProfileDragDropController();
    this._bindProfileBodyListeners();

    const index = this._pendingFocusProfileIndex;
    if (!Number.isFinite(index)) return;
    this._pendingFocusProfileIndex = null;

    requestAnimationFrame(() => {
      const input = this.bodyElement?.querySelector(`[name="profiles.${index}.type"]`);
      input?.closest?.("tr")?.scrollIntoView?.({ block: "nearest" });
      input?.focus?.();
      input?.select?.();
    });
  }

  _bindProfileBodyListeners() {
    this._bodyListenersAbort?.abort();
    const root = this.bodyElement ?? this.element;
    if (!root?.addEventListener) return;
    const controller = new AbortController();
    const listenerOptions = { signal: controller.signal };
    const captureOptions = { capture: true, signal: controller.signal };
    const doc = root.ownerDocument;
    root.addEventListener("input", this._onProfileFieldInput.bind(this), listenerOptions);
    root.addEventListener("change", this._onProfileFieldInput.bind(this), listenerOptions);
    root.addEventListener("dragenter", this._onProfileBodyDragOver.bind(this), captureOptions);
    root.addEventListener("dragover", this._onProfileBodyDragOver.bind(this), captureOptions);
    root.addEventListener("dragleave", this._onProfileBodyDragLeave.bind(this), captureOptions);
    root.addEventListener("drop", this._onProfileBodyDrop.bind(this), captureOptions);
    for (const zone of root.querySelectorAll?.(".looter-table-dropzone[data-index]") ?? []) {
      const targets = [zone, ...zone.querySelectorAll("*")];
      for (const target of targets) {
        target.addEventListener("dragenter", event => this._onTableLinkDragOver(event, zone), captureOptions);
        target.addEventListener("dragover", event => this._onTableLinkDragOver(event, zone), captureOptions);
        target.addEventListener("dragleave", event => {
          const next = event.relatedTarget;
          if (next && zone.contains(next)) return;
          this._onTableLinkDragLeave(event, zone);
        }, captureOptions);
        target.addEventListener("drop", event => {
          void this._onTableLinkDrop(event, zone);
        }, captureOptions);
      }
    }
    doc?.addEventListener("dragenter", this._onProfileDocumentDrag.bind(this), captureOptions);
    doc?.addEventListener("dragover", this._onProfileDocumentDrag.bind(this), captureOptions);
    doc?.addEventListener("dragleave", this._onProfileDocumentDragLeave.bind(this), captureOptions);
    doc?.addEventListener("drop", this._onProfileDocumentDrop.bind(this), captureOptions);
    this._bodyListenersAbort = controller;
  }

  _updateDraftProfileFromField(field) {
    const row = field?.closest?.("tr[data-index]");
    const index = Number(row?.dataset.index);
    if (!Number.isFinite(index)) return;

    const match = /^profiles\.(\d+)\.(.+)$/.exec(String(field.name || ""));
    if (!match) return;

    const current = normalizeProfile(this._draftProfiles[index] || {});
    const path = match[2];

    if (path === "type") current.type = String(field.value ?? "").trim();
    else if (path === "tier") current.tier = String(field.value ?? "0-4");
    else if (path === "tableRolls") current.tableRolls = String(field.value ?? "1");
    else if (path === "itemTable") current.itemTable = String(field.value ?? "").trim();
    else if (path.startsWith("currency.")) {
      const denom = path.slice("currency.".length);
      if (!["pp", "gp", "ep", "sp", "cp"].includes(denom)) return;
      current.currency[denom] = String(field.value ?? "").trim();
    } else return;

    this._draftProfiles[index] = normalizeProfile(current);
  }

  _onProfileFieldInput(event) {
    const target = getEventTargetElement(event);
    if (!target?.matches?.('[name^="profiles."]')) return;
    this._updateDraftProfileFromField(target);
  }

  _collectProfiles(root = this.bodyElement, { includeBlank = false } = {}) {
    const profiles = [];
    for (const row of root?.querySelectorAll?.("tbody.looter-profiles tr[data-index]") ?? []) {
      const profile = normalizeProfile({
        type: row.querySelector('input[name$=".type"]')?.value || "",
        tier: String(row.querySelector('select[name$=".tier"]')?.value || "0-4"),
        currency: {
          pp: row.querySelector('input[name$=".currency.pp"]')?.value || "",
          gp: row.querySelector('input[name$=".currency.gp"]')?.value || "",
          ep: row.querySelector('input[name$=".currency.ep"]')?.value || "",
          sp: row.querySelector('input[name$=".currency.sp"]')?.value || "",
          cp: row.querySelector('input[name$=".currency.cp"]')?.value || ""
        },
        tableRolls: row.querySelector('input[name$=".tableRolls"]')?.value || "1",
        itemTable: row.querySelector('input[name$=".itemTable"]')?.value || ""
      });
      if (!includeBlank && !profile.type) continue;
      profiles.push(profile);
    }
    return profiles;
  }

  _syncDraftProfilesFromRenderedInputs(root = this.bodyElement, { includeBlank = true } = {}) {
    if (!root && !this.element) return this._draftProfiles;
    const primaryRoot = root || this.element;
    let profiles = this._collectProfiles(primaryRoot, { includeBlank });
    if (!profiles.length && this.element && primaryRoot !== this.element) {
      profiles = this._collectProfiles(this.element, { includeBlank });
    }
    this._draftProfiles = profiles;
    return this._draftProfiles;
  }

  _setTableLinkDropState(target, active) {
    const zone = target?.closest?.(".looter-table-dropzone") || target;
    if (!zone) return;
    zone.classList.toggle("is-drop-target", active);
  }

  _setActiveTableDropzone(zone) {
    if (this._activeTableDropzone && this._activeTableDropzone !== zone) {
      this._setTableLinkDropState(this._activeTableDropzone, false);
    }
    this._activeTableDropzone = zone || null;
    if (zone) this._setTableLinkDropState(zone, true);
  }

  _findTableDropzoneByPoint(event) {
    return this._findDropzoneByPoint(".looter-table-dropzone[data-index]", event);
  }

  _findTableDropzoneFromEvent(event) {
    return this._findDropzoneFromEvent(".looter-table-dropzone[data-index]", event);
  }

  _onProfileDocumentDrag(event) {
    const zone = this._findTableDropzoneByPoint(event);
    if (!zone) {
      this._setActiveTableDropzone(null);
      return;
    }
    this._setActiveTableDropzone(zone);
    this._onTableLinkDragOver(event, zone);
  }

  _onProfileDocumentDragLeave(event) {
    const zone = this._findTableDropzoneByPoint(event);
    if (zone) return;
    this._setActiveTableDropzone(null);
  }

  _onProfileDocumentDrop(event) {
    const zone = this._findTableDropzoneByPoint(event);
    this._setActiveTableDropzone(null);
    if (!zone) return;
    void this._onTableLinkDrop(event, zone);
  }

  _onProfileBodyDragOver(event) {
    const zone = this._findTableDropzoneFromEvent(event);
    if (!zone) return;
    this._onTableLinkDragOver(event, zone);
  }

  _onProfileBodyDragLeave(event) {
    const zone = this._findTableDropzoneFromEvent(event);
    if (!zone) return;
    const next = event.relatedTarget;
    if (next && zone.contains(next)) return;
    this._onTableLinkDragLeave(event, zone);
  }

  _onProfileBodyDrop(event) {
    const zone = this._findTableDropzoneFromEvent(event);
    if (!zone) return;
    void this._onTableLinkDrop(event, zone);
  }

  _onTableLinkDragOver(event, target = event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    this._setTableLinkDropState(target, true);
    if ((event.originalEvent ?? event).dataTransfer) (event.originalEvent ?? event).dataTransfer.dropEffect = "copy";
  }

  _onTableLinkDragLeave(event, target = event.currentTarget) {
    event.stopPropagation();
    this._setTableLinkDropState(target, false);
  }

  async _onTableLinkDrop(event, target = event.currentTarget) {
    const dragEvent = event?.originalEvent ?? event;
    if (dragEvent?._looterTableDropHandled) return;
    if (dragEvent) dragEvent._looterTableDropHandled = true;

    event.preventDefault();
    event.stopPropagation();
    this._setActiveTableDropzone(null);
    this._setTableLinkDropState(target, false);

    const zone = target?.closest?.(".looter-table-dropzone") || target;
    const index = Number(zone?.dataset.index);
    if (!Number.isFinite(index)) return;

    const dropped = await resolveDroppedRollTable(event);
    if (!dropped?.reference) {
      ui.notifications.warn("Drop a RollTable from the Roll Tables directory or a RollTable compendium.");
      return;
    }

    await this._linkTableReference(index, dropped.reference);
  }

  async _addDraftProfile() {
    this._syncDraftProfilesFromRenderedInputs();
    this._draftProfiles.push(normalizeProfile({
      type: "Any",
      tier: "0-4",
      currency: defaultCurrencyBlock(),
      tableRolls: "1",
      itemTable: tableName("Any", "0-4")
    }));
    this._pendingFocusProfileIndex = Math.max(this._draftProfiles.length - 1, 0);
    await this.render({ force: true });
  }

  async _deleteDraftProfile(index) {
    this._syncDraftProfilesFromRenderedInputs();
    if (!Number.isFinite(index) || !this._draftProfiles[index]) return;
    this._draftProfiles.splice(index, 1);
    await this.render({ force: true });
  }

  async _seedProfiles() {
    await ensureTreasureProfiles();
    this._draftProfiles = getTreasureProfiles().map(normalizeProfile);
    ui.notifications.info("Looter starter treasure profiles are ready.");
    await this.render({ force: true });
  }

  async _linkTableReference(index, reference) {
    this._syncDraftProfilesFromRenderedInputs();
    if (!Number.isFinite(index) || !this._draftProfiles[index]) return;
    this._draftProfiles[index].itemTable = reference;
    ui.notifications.info(`Looter linked ${getRollTableDisplayName(reference)} in the draft profile. Click Save to persist.`);
    await this.render({ force: true });
  }

  async _clearLinkedTable(index) {
    this._syncDraftProfilesFromRenderedInputs();
    if (!Number.isFinite(index) || !this._draftProfiles[index]) return;
    this._draftProfiles[index].itemTable = "";
    ui.notifications.info("Looter cleared the linked RollTable in the draft profile. Click Save to persist.");
    await this.render({ force: true });
  }

  async _saveFromForm({ notify = true, rerender = true } = {}) {
    this._syncDraftProfilesFromRenderedInputs();
    const profiles = this._draftProfiles
      .map(normalizeProfile)
      .filter(profile => profile.type);
    await setTreasureProfiles(profiles);
    this._draftProfiles = profiles.map(normalizeProfile);
    if (notify) ui.notifications.info("Looter treasure profiles saved.");
    if (rerender) await this.render({ force: true });
  }

  async _preClose(options) {
    this._bodyListenersAbort?.abort();
    this._bodyListenersAbort = null;
    this._activeTableDropzone = null;
    this._dragDrop = null;
    this._dragDropBoundElement = null;
    this._dragDropSelector = null;
    return super._preClose(options);
  }
}

class LooterEncounterApp extends LooterApplicationV2 {
  constructor(snapshot, options = {}) {
    super(options);
    this.snapshot = clone(snapshot);
    this._bodyListenersAbort = null;
    this._activeEncounterDropzone = null;
    this._encounterDraggedItemIndex = null;
    this._encounterDraggedItemRow = null;
    this.rewardsState = {
      enemies: clone(snapshot.enemies),
      players: snapshot.players.map(p => ({ ...p })),
      xp: clampNumber(snapshot.totals.xp, 0),
      currency: clone(snapshot.totals.currency),
      items: snapshot.totals.items.map(i => ({ ...i, assignee: "" }))
    };
  }

  static get DEFAULT_OPTIONS() {
    const options = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "looter-encounter-rewards",
      position: {
        width: 1180,
        height: 760
      },
      window: {
        title: "Looter Rewards"
      }
    }, { inplace: false });
    options.classes = [...(options.classes ?? []), "looter-encounter", `theme-${getTheme()}`];
    return options;
  }

  static get PARTS() {
    return {
      body: {
        template: moduleAssetPath("templates/encounter-rewards.html"),
        root: true,
        scrollable: [".looter-enemy-list", ".looter-player-list", ".looter-loot-scroll"]
      }
    };
  }

  async _prepareContext(_options) {
    const items = this.rewardsState.items.map((item, index) => ({ ...item, index }));
    const players = this.rewardsState.players.map(player => ({
      ...player,
      assignedItems: items.filter(item => item.assignee === player.actorId),
    }));
    const unassignedItems = items.filter(item => !item.assignee);

    return {
      enemies: stackEnemiesForDisplay(this.rewardsState.enemies),
      players,
      items: unassignedItems,
      xp: this.rewardsState.xp,
      currency: this.rewardsState.currency,
      useXp: getUseXp()
    };
  }

  async _renderPreservingScroll() {
    await this.render({ force: true });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._bindEncounterBodyListeners();
  }

  _onClickAction(event, target) {
    const action = target.dataset.action;
    switch (action) {
      case "rerollRewards":
        event.preventDefault();
        void this._runLooterAction(
          () => this._reroll(),
          "Encounter rewards action failed",
          "Looter couldn't reroll the encounter rewards."
        );
        return;
      case "sendSummary":
        event.preventDefault();
        void this._runLooterAction(
          () => this._sendSummaryToChat(),
          "Encounter rewards action failed",
          "Looter couldn't send the reward summary to chat."
        );
        return;
      case "applyRewards":
        event.preventDefault();
        void this._runLooterAction(
          () => this._applyRewards(),
          "Encounter rewards action failed",
          "Looter couldn't apply the rewards."
        );
        return;
      case "rerollEnemy":
        event.preventDefault();
        event.stopPropagation();
        void this._runLooterAction(
          () => this._rerollEnemyRewards(String(target.dataset.indexes || "")),
          "Encounter rewards action failed",
          "Looter couldn't reroll that enemy's rewards."
        );
        return;
      case "rerollItem":
        event.preventDefault();
        event.stopPropagation();
        void this._runLooterAction(
          () => this._rerollLootItem(Number(target.dataset.index)),
          "Encounter rewards action failed",
          "Looter couldn't reroll that loot item."
        );
        return;
      case "unassignItem":
        event.preventDefault();
        void this._runLooterAction(
          () => this._unassignItem(Number(target.dataset.index)),
          "Encounter rewards action failed",
          "Looter couldn't return that item to the loot list."
        );
        return;
      default:
        return super._onClickAction(event, target);
    }
  }

  _bindEncounterBodyListeners() {
    this._bodyListenersAbort?.abort();
    const root = this.bodyElement ?? this.element;
    if (!root?.addEventListener) return;

    const controller = new AbortController();
    const listenerOptions = { signal: controller.signal };
    const captureOptions = { capture: true, signal: controller.signal };
    const doc = root.ownerDocument;

    root.addEventListener("click", this._onEncounterBodyClick.bind(this), listenerOptions);

    for (const row of root.querySelectorAll?.(".looter-item-row[data-index]") ?? []) {
      row.draggable = true;
    }

    for (const card of root.querySelectorAll?.(".looter-player-card") ?? []) {
      const targets = [card, ...card.querySelectorAll("*")];
      for (const target of targets) {
        target.addEventListener("dragenter", event => this._onEncounterDropZoneOver(event, card), captureOptions);
        target.addEventListener("dragover", event => this._onEncounterDropZoneOver(event, card), captureOptions);
        target.addEventListener("dragleave", event => this._onEncounterDropZoneLeave(event, card), captureOptions);
        target.addEventListener("drop", event => void this._onEncounterPlayerDrop(event, card), captureOptions);
      }
    }

    for (const zone of root.querySelectorAll?.(".looter-unassigned-dropzone") ?? []) {
      const targets = [zone, ...zone.querySelectorAll("*")];
      for (const target of targets) {
        target.addEventListener("dragenter", event => this._onEncounterDropZoneOver(event, zone), captureOptions);
        target.addEventListener("dragover", event => this._onEncounterDropZoneOver(event, zone), captureOptions);
        target.addEventListener("dragleave", event => this._onEncounterDropZoneLeave(event, zone), captureOptions);
        target.addEventListener("drop", event => void this._onEncounterDeleteDrop(event, zone), captureOptions);
      }
    }

    doc?.addEventListener("mousedown", this._onEncounterDocumentMouseDown.bind(this), captureOptions);
    doc?.addEventListener("dragstart", this._onEncounterDocumentDragStart.bind(this), captureOptions);
    doc?.addEventListener("dragend", this._onEncounterDocumentDragEnd.bind(this), captureOptions);
    doc?.addEventListener("dragenter", this._onEncounterDocumentDrag.bind(this), captureOptions);
    doc?.addEventListener("dragover", this._onEncounterDocumentDrag.bind(this), captureOptions);
    doc?.addEventListener("dragleave", this._onEncounterDocumentDragLeave.bind(this), captureOptions);
    doc?.addEventListener("drop", this._onEncounterDocumentDrop.bind(this), captureOptions);

    this._bodyListenersAbort = controller;
  }

  _onEncounterBodyClick(event) {
    const target = getEventTargetElement(event);
    if (!target) return;
    if (target.closest("[data-action]")) return;

    const row = target.closest(".looter-item-row[data-index]");
    if (!row) return;

    event.preventDefault();
    void this._runLooterAction(
      () => this._openItem(Number(row.dataset.index)),
      "Encounter item preview failed",
      "Looter couldn't open that loot item."
    );
  }

  _setEncounterDropState(target, active) {
    const zone = target?.closest?.(".looter-player-card, .looter-unassigned-dropzone") || target;
    if (!zone) return;
    zone.classList.toggle("is-drop-target", active);
  }

  _setActiveEncounterDropzone(zone) {
    if (this._activeEncounterDropzone && this._activeEncounterDropzone !== zone) {
      this._setEncounterDropState(this._activeEncounterDropzone, false);
    }
    this._activeEncounterDropzone = zone || null;
    if (zone) this._setEncounterDropState(zone, true);
  }

  _clearEncounterDropTargets() {
    this._setActiveEncounterDropzone(null);
    const root = this.bodyElement ?? this.element;
    for (const zone of root?.querySelectorAll?.(".looter-player-card.is-drop-target, .looter-unassigned-dropzone.is-drop-target") ?? []) {
      zone.classList.remove("is-drop-target");
    }
  }

  _findEncounterDropzoneByPoint(event) {
    const dragEvent = event?.originalEvent ?? event;
    const x = Number(dragEvent?.clientX);
    const y = Number(dragEvent?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const doc = (this.bodyElement ?? this.element)?.ownerDocument;
    for (const node of doc?.elementsFromPoint?.(x, y) ?? []) {
      const zone = node?.closest?.(".looter-player-card, .looter-unassigned-dropzone");
      if (zone) return zone;
    }

    return this._findDropzoneByPoint(".looter-player-card, .looter-unassigned-dropzone", event);
  }

  _getDraggedEncounterItemIndex(event) {
    const dragEvent = event?.originalEvent ?? event;
    const dataTransfer = dragEvent?.dataTransfer;
    const raw = String(
      dataTransfer?.getData("application/x-looter-item-index")
      || dataTransfer?.getData("text/plain")
      || ""
    ).trim();
    if (!raw) {
      const rowIndex = Number(this._encounterDraggedItemRow?.dataset?.index);
      if (Number.isFinite(rowIndex)) return rowIndex;
      return Number.isFinite(this._encounterDraggedItemIndex) ? this._encounterDraggedItemIndex : null;
    }
    const index = Number(raw);
    if (Number.isFinite(index)) return index;
    const rowIndex = Number(this._encounterDraggedItemRow?.dataset?.index);
    if (Number.isFinite(rowIndex)) return rowIndex;
    return Number.isFinite(this._encounterDraggedItemIndex) ? this._encounterDraggedItemIndex : null;
  }

  _onEncounterRowPointerDown(event) {
    const target = getEventTargetElement(event);
    if (!target || target.closest("[data-action], input, select, textarea, button, a, label")) return;

    const row = target.closest(".looter-item-row[data-index]");
    const index = Number(row?.dataset.index);
    if (!row || !Number.isFinite(index)) return;

    this._encounterDraggedItemIndex = index;
    this._encounterDraggedItemRow = row;
  }

  _encounterAppContains(node) {
    if (!node) return false;
    const containers = [this.bodyElement, this.element, this.window?.content]
      .filter(container => typeof container?.contains === "function");
    return containers.some(container => container.contains(node));
  }

  _findEncounterLootRowFromEvent(event) {
    const target = getEventTargetElement(event);
    const targetMatch = target?.closest?.(".looter-item-row[data-index]");
    if (this._encounterAppContains(targetMatch)) return targetMatch;

    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (node?.matches?.(".looter-item-row[data-index]") && this._encounterAppContains(node)) return node;
      const row = node?.closest?.(".looter-item-row[data-index]");
      if (this._encounterAppContains(row)) return row;
    }

    return null;
  }

  _onEncounterDocumentMouseDown(event) {
    if (event.button !== 0) return;
    const row = this._findEncounterLootRowFromEvent(event);
    if (!row) return;
    this._onEncounterRowPointerDown(event);
  }

  _onEncounterDocumentDragStart(event) {
    const row = this._findEncounterLootRowFromEvent(event);
    if (!row) return;
    this._onEncounterItemDragStart(event, row);
  }

  _onEncounterDocumentDragEnd(event) {
    const row = this._findEncounterLootRowFromEvent(event) ?? this._encounterDraggedItemRow;
    if (!row) return;
    this._onEncounterItemDragEnd(row);
  }

  _onEncounterItemDragStart(event, row = event.currentTarget) {
    const dragEvent = event?.originalEvent ?? event;
    const index = Number(row?.dataset.index);
    if (!Number.isFinite(index)) return;

    this._encounterDraggedItemIndex = index;
    this._encounterDraggedItemRow = row ?? null;
    row?.classList?.add("is-dragging");
    dragEvent.dataTransfer?.setData("application/x-looter-item-index", String(index));
    dragEvent.dataTransfer?.setData("text/plain", String(index));
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.effectAllowed = "move";
  }

  _onEncounterItemDragEnd(row = this._encounterDraggedItemRow) {
    this._clearEncounterDropTargets();
    row?.classList?.remove("is-dragging");
  }

  _onEncounterDocumentDrag(event) {
    const zone = this._findEncounterDropzoneByPoint(event);
    if (!zone) {
      this._setActiveEncounterDropzone(null);
      return;
    }

    this._setActiveEncounterDropzone(zone);
    this._onEncounterDropZoneOver(event, zone);
  }

  _onEncounterDocumentDragLeave(event) {
    const zone = this._findEncounterDropzoneByPoint(event);
    if (zone) return;
    this._setActiveEncounterDropzone(null);
  }

  _onEncounterDocumentDrop(event) {
    const zone = this._findEncounterDropzoneByPoint(event);
    this._setActiveEncounterDropzone(null);
    if (!zone) return;

    if (zone.matches(".looter-player-card")) {
      void this._onEncounterPlayerDrop(event, zone);
      return;
    }

    if (zone.matches(".looter-unassigned-dropzone")) {
      void this._onEncounterDeleteDrop(event, zone);
    }
  }

  _onEncounterDropZoneOver(event, zone = event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    this._setEncounterDropState(zone, true);
    this._setActiveEncounterDropzone(zone);
    const dragEvent = event?.originalEvent ?? event;
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
  }

  _onEncounterDropZoneLeave(event, zone = event.currentTarget) {
    const next = event.relatedTarget;
    if (next && zone?.contains?.(next)) return;
    this._setEncounterDropState(zone, false);
    if (this._activeEncounterDropzone === zone) this._activeEncounterDropzone = null;
  }

  async _onEncounterPlayerDrop(event, zone = event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    this._setEncounterDropState(zone, false);
    if (this._activeEncounterDropzone === zone) this._activeEncounterDropzone = null;

    const index = this._getDraggedEncounterItemIndex(event);
    const actorId = String(zone?.dataset.actorId || "");
    if (!Number.isFinite(index) || !this.rewardsState.items[index] || !actorId) return;

    this.rewardsState.items[index].assignee = actorId;
    this._encounterDraggedItemRow = null;
    this._encounterDraggedItemIndex = null;
    await this._renderPreservingScroll();
  }

  async _onEncounterDeleteDrop(event, zone = event.currentTarget) {
    event.preventDefault();
    event.stopPropagation();
    this._setEncounterDropState(zone, false);
    if (this._activeEncounterDropzone === zone) this._activeEncounterDropzone = null;

    const index = this._getDraggedEncounterItemIndex(event);
    if (!Number.isFinite(index) || !this.rewardsState.items[index]) return;

    this.rewardsState.items.splice(index, 1);
    this._encounterDraggedItemRow = null;
    this._encounterDraggedItemIndex = null;
    await this._renderPreservingScroll();
  }

  async _applyRewards() {
    const root = this.bodyElement;
    if (!root) return;

    await this._syncStateFromForm(root);
    await grantRewards(this._payloadForApply());
    ui.notifications.info("Looter rewards applied.");
    await this.render({ force: true });
  }

  async _sendSummaryToChat() {
    const root = this.bodyElement;
    if (!root) return;

    await this._syncStateFromForm(root);
    const payload = this._payloadForApply();
    payload.items = payload.items.map(item => ({ ...item, assigneeName: this.rewardsState.players.find(p => p.actorId === item.assignee)?.name || "" }));
    await ChatMessage.create({
      content: await rewardsSummaryChatHTML(payload),
      speaker: ChatMessage.getSpeaker({ alias: "Looter" })
    });
    ui.notifications.info("Looter summary sent to chat.");
  }

  async _unassignItem(index) {
    if (!Number.isFinite(index) || !this.rewardsState.items[index]) return;
    this.rewardsState.items[index].assignee = "";
    await this._renderPreservingScroll();
  }

  async _syncStateFromForm(root) {
    this.rewardsState.players.forEach((player, idx) => {
      const checkbox = root.querySelector(`[name="players.${idx}.enabled"]`);
      player.enabled = checkbox ? checkbox.checked : true;
    });

    this.rewardsState.xp = clampNumber(root.querySelector('[name="xp"]')?.value, this.rewardsState.xp);
    for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
      this.rewardsState.currency[denom] = clampNumber(root.querySelector(`[name="currency.${denom}"]`)?.value, 0);
    }

  }

  _parseEnemyIndexes(value) {
    return String(value ?? "")
      .split(",")
      .map(v => Number(v.trim()))
      .filter(Number.isFinite);
  }

  _rebuildCurrencyFromEnemyRewards() {
    const totals = zeroCurrencyTotals();
    for (const enemy of this.rewardsState.enemies) addCurrencyTotals(totals, enemy?.rewards?.currency);
    this.rewardsState.currency = totals;
  }

  _replaceEnemyRewardItem(itemId, replacement) {
    for (const enemy of this.rewardsState.enemies) {
      const rewardItems = Array.isArray(enemy?.rewards?.items) ? enemy.rewards.items : [];
      const itemIndex = rewardItems.findIndex(item => item.id === itemId);
      if (itemIndex < 0) continue;
      rewardItems[itemIndex] = clone(replacement);
      return;
    }
  }

  async _rerollEnemyRewards(indexesValue) {
    const root = this.bodyElement;
    if (!root) return;

    await this._syncStateFromForm(root);
    const indexes = [...new Set(this._parseEnemyIndexes(indexesValue))];
    if (!indexes.length) return;

    for (const index of indexes) {
      const enemy = this.rewardsState.enemies[index];
      if (!enemy) continue;

      const oldRewardItems = Array.isArray(enemy.rewards?.items)
        ? enemy.rewards.items.map(item => {
          const liveItem = this.rewardsState.items.find(stateItem => stateItem.id === item.id);
          return clone(liveItem || item);
        })
        : [];
      const oldIds = new Set(oldRewardItems.map(item => item.id));
      const oldIndexes = oldRewardItems
        .map(item => this.rewardsState.items.findIndex(stateItem => stateItem.id === item.id))
        .filter(i => i >= 0)
        .sort((a, b) => a - b);
      const insertAt = oldIndexes[0] ?? this.rewardsState.items.length;
      const keptItems = this.rewardsState.items.filter(item => !oldIds.has(item.id));

      const freshRewards = await rollFromTreasurePlan({
        cr: enemy.cr,
        treasureTypes: enemy.treasureTypes
      });

      const freshItems = freshRewards.items.map((item, itemIndex) => ({
        ...item,
        id: oldRewardItems[itemIndex]?.id || item.id,
        assignee: oldRewardItems[itemIndex]?.assignee || ""
      }));

      keptItems.splice(insertAt, 0, ...freshItems);
      this.rewardsState.items = keptItems;
      enemy.rewards = {
        currency: clone(freshRewards.currency),
        items: freshItems.map(item => clone(item))
      };
    }

    this._rebuildCurrencyFromEnemyRewards();
    await this._renderPreservingScroll();

    const firstEnemy = this.rewardsState.enemies[indexes[0]];
    const label = firstEnemy ? (indexes.length > 1 ? `${firstEnemy.name} x${indexes.length}` : firstEnemy.name) : "enemy rewards";
    ui.notifications.info(`Looter rerolled ${label}.`);
  }

  async _rerollLootItem(index) {
    const root = this.bodyElement;
    const item = this.rewardsState.items[index];
    if (!root || !item) return;

    await this._syncStateFromForm(root);
    const profile = findTreasureProfile(item.sourceType, item.tier) || findTreasureProfile("Any", item.tier);
    if (!profile?.itemTable) {
      ui.notifications.warn(`No RollTable is linked for ${item.sourceType} ${item.tier}.`);
      return;
    }

    const replacementItems = await drawItemsFromTable(profile.itemTable, item.sourceType, item.tier, 1);
    const replacementSource = replacementItems[0];
    if (!replacementSource) {
      ui.notifications.warn("That RollTable did not produce any rerollable loot.");
      return;
    }

    const replacement = {
      ...replacementSource,
      id: item.id,
      assignee: item.assignee || ""
    };
    this.rewardsState.items[index] = replacement;
    this._replaceEnemyRewardItem(item.id, replacement);
    await this._renderPreservingScroll();
    ui.notifications.info(`Looter rerolled ${item.name}.`);
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
    this.rewardsState.enemies = clone(fresh.enemies);
    this.rewardsState.xp = fresh.totals.xp;
    this.rewardsState.currency = clone(fresh.totals.currency);
    this.rewardsState.items = fresh.totals.items.map(i => ({ ...i, assignee: "" }));
    await this._renderPreservingScroll();
  }

  _payloadForApply() {
    return {
      players: clone(this.rewardsState.players),
      xp: this.rewardsState.xp,
      currency: clone(this.rewardsState.currency),
      items: clone(this.rewardsState.items)
    };
  }

  async _openItem(idx) {
    if (!Number.isFinite(idx) || !this.rewardsState.items[idx]) return;
    const item = this.rewardsState.items[idx];

    try {
      if (item.sourceUuid) {
        const doc = await fromUuid(item.sourceUuid);
        if (doc) {
          if (doc.sheet && typeof doc.sheet.render === "function") {
            doc.sheet.render(true);
            return;
          }
          if (doc instanceof Item && typeof doc.sheet?.render === "function") {
            doc.sheet.render(true);
            return;
          }
        }
      }
    } catch (err) {
      console.warn(`${LOOTER_ID} | Failed to open source document for item`, err, item);
    }

    const data = item.itemData || {};
    const description = (data?.system?.description?.value) || (data?.data?.description?.value) || data?.description || "";
    const safeImg = foundry.utils.escapeHTML(item.img || "");
    const content = `<div class="looter-item-preview"><div style="display:flex;gap:12px;align-items:flex-start;"><img src="${safeImg}" alt="" style="width:96px;height:auto;border-radius:4px;"/><div>${description || "<p>No description available.</p>"}</div></div></div>`;

    new Dialog({
      title: item.name || "Item",
      content,
      buttons: { close: { label: "Close" } },
      default: "close"
    }).render(true);
  }

  async _preClose(options) {
    this._bodyListenersAbort?.abort();
    this._bodyListenersAbort = null;
    this._activeEncounterDropzone = null;
    this._encounterDraggedItemRow = null;
    this._encounterDraggedItemIndex = null;
    return super._preClose(options);
  }
}

async function focusOrRenderLooterApp(AppClass) {
  const instances = Array.from(AppClass.instances());
  const existing = instances.find(app => app.rendered && app.element?.isConnected);

  if (existing) {
    if (existing.minimized) await existing.maximize();
    await existing.render({ force: true });
    existing.bringToFront();
    return existing;
  }

  for (const stale of instances) {
    await stale.close();
  }

  const app = new AppClass();
  await app.render({ force: true });
  app.bringToFront();
  return app;
}

function openMonsterTableApp() {
  void focusOrRenderLooterApp(LooterMonsterTableApp);
}

function openTreasureProfilesApp() {
  void focusOrRenderLooterApp(LooterTreasureProfilesApp);
}

function openEncounterApp(snapshot) {
  if (!snapshot) return;
  const existing = Array.from(LooterEncounterApp.instances()).find(app => app.rendered);
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
  const liveNamespace = getLooterModule()?.id || MODULE_FOLDER || LOOTER_ID;
  SETTINGS_NAMESPACE = liveNamespace;

  if (SETTINGS_NAMESPACE !== LOOTER_ID) {
    console.warn(
      `${LOOTER_ID} | Registering settings under live package id "${SETTINGS_NAMESPACE}". ` +
      `Rename the module folder to "${LOOTER_ID}" to keep package ids and settings namespaces aligned.`
    );
    registerLooterSettings(LOOTER_ID, { forceHidden: true });
  }

  registerLooterSettings(SETTINGS_NAMESPACE, { includeMenus: true });
  void (async () => {
    await migrateLegacySettingsNamespace(LOOTER_ID, SETTINGS_NAMESPACE);
    await normalizeStructuredSettings(SETTINGS_NAMESPACE);
    await syncSettingsNamespace(SETTINGS_NAMESPACE, LOOTER_ID);
    await normalizeStructuredSettings(LOOTER_ID);
  })();
});

Hooks.once("ready", async () => {
  await ensureWorldTables();
  await ensureTreasureProfiles();
  const looterModule = getLooterModule();
  if (!looterModule) {
    console.warn(
      `${LOOTER_ID} | Could not resolve this package in game.modules, so the public API was not registered.`
    );
    return;
  }

  looterModule.api = {
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
  const root = html?.querySelector ? html : html?.[0];
  const header = root?.querySelector?.(".directory-header");
  if (!header || header.querySelector(".looter-directory-shortcut")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "looter-directory-shortcut";
  button.innerHTML = `<i class="fas fa-dragon"></i> Monster Registry`;
  button.addEventListener("click", ev => {
    ev.preventDefault();
    openMonsterTableApp();
  });

  const actions = header.querySelector(".header-actions") || header.querySelector(".action-buttons");
  if (actions) {
    actions.append(button);
    return;
  }

  const search = header.querySelector(".header-search");
  if (search) search.before(button);
  else header.append(button);
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

