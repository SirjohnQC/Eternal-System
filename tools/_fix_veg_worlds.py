"""Complete VegetationWorlds.ts — fix truncated ASH + append packs."""
from pathlib import Path
import re

p = Path('src/rendering/VegetationWorlds.ts')
t = p.read_text(encoding='utf-8')
idx = t.find('const ASH = V(')
bli = t.find('const BLISTER = V(')
assert idx >= 0 and bli >= 0
head = t[:idx]
mid = t[bli:]
mid = re.sub(r'// Fix ASH rows[\s\S]*', '', mid)
mid = re.sub(r'const ASH_CLEAN = V\([\s\S]*?\);\s*', '', mid)

ash = """
const ASH = V(
  [
    '................', '................', '................', '................',
    '................', '................', '......ggggg.....', '.....ggggg......',
    '....gssmhlsg....', '...gAssmmlssa...', '....gAsssssa....', '.....gArrra.....',
    '................', '................', '................', '................',
  ],
  [
    '................', '................', '................', '................',
    '................', '....ggg..ggg....', '...gAlg.gAmg....', '..gAsmlgAsmlg...',
    '.gAssmlmlmlssa..', '..gAssmlmlssa...', '...gAssssssa....', '....gArr.rra....',
    '................', '................', '................', '................',
  ],
  [
    '................', '................', '................', '................',
    '................', '................', '.....gg...gg....', '....gmlmlg.gmlmlg...',
    '...gAssg.gAssg..', '..gAssssgAssssg.', '...gArr...Arrg..', '................',
    '................', '................', '................', '................',
  ],
);
""".replace("'....gmlmlg.gmlmlg...'", "'....gmlmlg.gmlmlg...'")

# Force correct 16-char row
row = '....' + 'gmlmlg' + '.' + 'gmlmlg' + '...'
row = row.replace('$', 'g')
assert len(row) == 16, (row, len(row))
ash = ash.replace("'....gmlmlg.gmlmlg...'", repr(row)).replace(f"'{row}'" if False else "PLACEHOLDER", "PLACEHOLDER")
# simpler: build ash without the bad row
ash = f"""
const ASH = V(
  [
    '................', '................', '................', '................',
    '................', '................', '......ggggg.....', '.....ggggg......',
    '....gssmhlsg....', '...gAssmmlssa...', '....gAsssssa....', '.....gArrra.....',
    '................', '................', '................', '................',
  ],
  [
    '................', '................', '................', '................',
    '................', '....ggg..ggg....', '...gAlg.gAmg....', '..gAsmlgAsmlg...',
    '.gAssmlmlmlssa..', '..gAssmlmlssa...', '...gAssssssa....', '....gArr.rra....',
    '................', '................', '................', '................',
  ],
  [
    '................', '................', '................', '................',
    '................', '................', '.....gg...gg....', '{row}',
    '...gAssg.gAssg..', '..gAssssgAssssg.', '...gArr...Arrg..', '................',
    '................', '................', '................', '................',
  ],
);
"""

tail = """
const ROCKY: WorldPack = pack(
  { pal: PINE_PAL, rows: PINE },
  { pal: FOREST, rows: LEAF },
  { pal: FOREST, rows: SCRUB },
  { pal: ARID, rows: CACTUS },
  { pal: STONE, rows: ROCK },
);

const OCEAN: WorldPack = pack(
  { pal: OCEAN_PAL, rows: PALM },
  { pal: OCEAN_PAL, rows: LEAF },
  { pal: OCEAN_PAL, rows: SCRUB },
  { pal: OCEAN_PAL, rows: REED },
  { pal: OCEAN_PAL, rows: ROCK },
);

const ICE: WorldPack = pack(
  { pal: ICE_PAL, rows: PINE },
  { pal: ICE_PAL, rows: LEAF },
  { pal: ICE_PAL, rows: SCRUB },
  { pal: ICE_PAL, rows: REED },
  { pal: ICE_PAL, rows: ROCK },
);

const DESERT: WorldPack = pack(
  { pal: ARID, rows: PINE },
  { pal: ARID, rows: LEAF },
  { pal: ARID, rows: SCRUB },
  { pal: ARID, rows: CACTUS },
  { pal: STONE, rows: ROCK },
);

const LAVA: WorldPack = pack(
  { pal: LAVA_PAL, rows: CHAR },
  { pal: LAVA_PAL, rows: EMBER },
  { pal: LAVA_PAL, rows: ASH },
  { pal: LAVA_PAL, rows: EMBER },
  { pal: LAVA_PAL, rows: ROCK },
);

const TOXIC: WorldPack = pack(
  { pal: TOXIC_PAL, rows: LEAF },
  { pal: TOXIC_PAL, rows: BLISTER },
  { pal: TOXIC_PAL, rows: SCRUB },
  { pal: TOXIC_PAL, rows: BLISTER },
  { pal: TOXIC_PAL, rows: ROCK },
);

const CRYSTAL: WorldPack = pack(
  { pal: CRYSTAL_PAL, rows: PRISM },
  { pal: CRYSTAL_PAL, rows: LEAF },
  { pal: CRYSTAL_PAL, rows: SCRUB },
  { pal: CRYSTAL_PAL, rows: SHARD },
  { pal: CRYSTAL_PAL, rows: ROCK },
);

const STORM: WorldPack = pack(
  { pal: STORM_PAL, rows: SCARRED },
  { pal: STORM_PAL, rows: PINE },
  { pal: STORM_PAL, rows: SCRUB },
  { pal: STORM_PAL, rows: REED },
  { pal: STORM_PAL, rows: ROCK },
);

const CARBON: WorldPack = pack(
  { pal: CARBON_PAL, rows: SOOT },
  { pal: CARBON_PAL, rows: LEAF },
  { pal: CARBON_PAL, rows: SCRUB },
  { pal: CARBON_PAL, rows: CHAR },
  { pal: CARBON_PAL, rows: ROCK },
);

const PACKS: Partial<Record<HabitableType, WorldPack>> = {
  ocean: OCEAN,
  rocky: ROCKY,
  ice: ICE,
  desert: DESERT,
  lava: LAVA,
  toxic: TOXIC,
  crystal: CRYSTAL,
  storm: STORM,
  carbon: CARBON,
};

/** Flora pack for a world. Gas / unknown fall back to rocky (planner skips gas). */
export function getWorldPack(world: HabitableType | string): WorldPack {
  return PACKS[world as HabitableType] ?? ROCKY;
}

export const FLORA_WORLDS: HabitableType[] = [
  'ocean', 'rocky', 'ice', 'desert', 'lava', 'toxic', 'crystal', 'storm', 'carbon',
];
"""

out = head + ash + mid + tail
# If mid still has trailing incomplete stuff after palettes, OK as long as PACKS follow
p.write_text(out, encoding='utf-8')
print('wrote', p, 'lines', out.count(chr(10)) + 1)
print('ends with', out.strip()[-120:])
