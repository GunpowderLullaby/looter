# Looter

**Looter** is a Foundry VTT module for **D&D 5e (2024)** that automates post-combat rewards using customizable, DMG-style treasure tables.

It replaces manual loot tracking with a fast, visual workflow that lets GMs roll, review, and distribute rewards in seconds.

---

## Features

### Automatic Post-Combat Rewards
- Detects when combat ends
- Gathers defeated enemies
- Rolls loot based on configured treasure types and CR
- Opens a **reward distribution UI** automatically

---

### DMG-Style Treasure System
- Supports treasure types like:
  - Arcana
  - Armaments
  - Individual
  - Any
  - None
- Rolls from **customizable RollTables**
- Uses CR tiers (0–4, 5–10, 11–16, 17+)

---

### Monster Registry
- Define loot behavior per creature:
  - Name
  - CR
  - XP
  - Treasure Types (multi-select)
- Drag-and-drop NPCs from the Actor Directory to auto-import

---

### Treasure Profiles
- Configure how each treasure type behaves:
  - Currency formulas (e.g., `6d6*10`)
  - Linked RollTables (via picker tool)
  - Number of rolls (supports dice like `1d4`)
- Fully editable by the GM

---

### RollTable Picker
- Drag a RollTable into the **Item Table** field
- Works with **world RollTables** and **RollTable compendiums**
- No manual typing or picker dialog

---

### Loot Distribution UI
- Clean 3-column layout:
  - **Enemies**
  - **Players**
  - **Loot**
- Drag-and-drop items to assign loot
- Remove items from players back to the loot pool
- Supports compendium-backed items with full data and icons

---

### Currency Support
- Rolls currency using dice formulas
- Aggregates totals across all defeated enemies

---

## Requirements

- **Foundry VTT**: v13.351  
- **System**: D&D 5e v5.2.5  

---

## Installation

### Manual Install
1. Download the latest release `.zip`
2. Extract into: FoundryVTT/Data/modules/looter
3. Restart Foundry
4. Enable **Looter** in your world

---

## Usage

### 1. Configure Monsters
Open **Looter → Monster Registry**
- Add monsters manually or drag NPCs in
- Assign CR, XP, and Treasure Types

### 2. Configure Treasure Profiles
Open **Looter → Treasure Profiles**
- Define currency formulas
- Drag world or compendium RollTables into the Item Table field
- Set how many times tables roll

### 3. Run Combat
- End combat as normal
- Looter automatically opens the rewards UI

### 4. Distribute Loot
- Drag items to players
- Adjust as needed
- Apply rewards

---

## Example

A **Mage (CR 6)** with:
- Treasure Types: `Arcana`, `Individual`

Looter will:
- Roll:
- `Arcana 5–10`
- `Individual 5–10`
- Combine results
- Display them in the loot UI

---

## Design Goals

- **Fast** — minimal clicks after combat  
- **Flexible** — fully GM-configurable tables  
- **Accurate** — follows DMG treasure logic  
- **Visual** — intuitive drag-and-drop interface  

---

## Roadmap

Planned improvements:
- Item stacking (e.g., Potion ×3)
- Currency auto-split
- Drag currency to players
- Loot history / persistence
- UI polish and animations

---

## Known Issues

- RollTables must use **document results** (not text) to pull full items
- Some UI elements may vary depending on Foundry theme

---

## Contributing

Feedback, suggestions, and bug reports are welcome.

---

## License

MIT License (or update as needed)

---

## Author

**GunpowderLullaby**

---

## Support

If you find Looter useful, consider starring the repo!
