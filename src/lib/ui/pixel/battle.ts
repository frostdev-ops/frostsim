// The pixel battle behind the running-sim panel. One Battle per mounted canvas: step() advances
// the world at a fixed 12 Hz, draw() paints it at native 176×56 for nearest-neighbour scaling.
// A multi-character run fights as a party: every character is a hero in its own lane, with its
// own look, attack and pets, against the same enemies.
// Everything the player sees is tied to the run: cast rate follows iterations per second, damage
// numbers are the running DPS estimate, the boss's health is the run's remaining progress, and the
// convergence of the estimate is drawn faintly behind the fight.
import type { Encounter, HeroStyle, MobKind, Pet as PetKind } from './style'

export const W = 176
export const H = 56
const GROUND = 49
const HOME = 14
/** Heroes a party draws; more would not fit the width. */
export const MAX_PARTY = 6
/** Each party member's depth offset: alternate rows so heroes side by side do not cover each other. */
const LANES = [0, -5, 3, -9, 1, -4]

export interface Input {
  speed?: number
  dps?: number
  progress?: number
  samples: { mean: number; err: number }[]
}

type Map = Record<string, string>

// ---- sprites --------------------------------------------------------------

const HEADS: Record<HeroStyle['head'], string[]> = {
  hood: ['....DDDD....', '...DddddD...', '...DSSSSD...', '...DSESED...', '....SSSS....'],
  helm: ['....DDDD....', '...DDddDD...', '...DDDDDD...', '...DEDDED...', '....SSSS....'],
  hat: ['.....DD.....', '....DDDD....', '..DDDDDDDD..', '....SESE....', '....SSSS....'],
  horns: ['..h......h..', '..hDDDDDDh..', '...DSSSSD...', '...DSESED...', '....SSSS....'],
  hair: ['....DDDD....', '...DDDDDD...', '...DSSSSD...', '...DSESED...', '....SSSS....'],
  mask: ['....DDDD....', '...DDDDDD...', '...SSSSSS...', '...TTTTTT...', '....SSSS....'],
  antlers: ['.h.h....h.h.', '..hh....hh..', '...DSSSSD...', '...DSESED...', '....SSSS....'],
}
const BODY = [
  '...AAAAAA...', '..AATAATAA..', '..AAAAAAAA..', '..AaATTAaA..', '..AAAAAAAA..',
  '...AaaaaA...', '...AA..AA...', '...AA..AA...', '...BB..BB...',
]

const SLIME = ['...MMMM...', '..MMMMMM..', '.MmEMMEmM.', '.MMMMMMMM.', 'MMMMMMMMMM', '.mmmmmmmm.']
const IMP = [
  ['.h.....h.', '.hMMMMMh.', '..MEMEM..', '..MMMMM..', 'w.MmMmM.w', 'wwMMMMMww', '..MMMMM..', '..M...M..'],
  ['.h.....h.', '.hMMMMMh.', 'w.MEMEM.w', '.wMMMMMw.', '..MmMmM..', '..MMMMM..', '..MMMMM..', '..M...M..'],
]
const SKELETON = [
  '..MMMM..', '.MEMMEM.', '.MMMMMM.', '..MmmM..', '.m.MM.m.', 'M.MMMM.M', '..MmmM..',
  '..MMMM..', '..M..M..', '..M..M..', '.MM..MM.',
]
const DUMMY = [
  '...hhhh...', '..hMMMMh..', '..MEMMEM..', '..MMMMMM..', '.MMmMMmMM.', 'MMMMMMMMMM', '.MMmMMmMM.',
  '..MMMMMM..', '....ww....', '....ww....', '....ww....', '...wwww...', '..wwwwww..',
]
const BOSS = [
  '.......hhhhhh.......', '.....hhMMMMMMhh.....', '....hMMMMMMMMMMh....', '...MMMEEMMMMEEMMM...',
  '...MMMEEMMMMEEMMM...', '..MMMMMMMmmMMMMMMM..', '..MMmMMMMMMMMMMmMM..', '.MMMMsMMMMMMMMsMMMM.',
  '.MMMMMsssssssssMMMMM', 'MMMMMMMMMMMMMMMMMMMM', 'MMmMMMMMMsMMMMMMmMMM', 'MMMMMMMMMsMMMMMMMMMM',
  '.MMMMmMMMsMMMMmMMMM.', '.MMMMMMMMsMMMMMMMMM.', '..MMMMMMMMMMMMMMMM..', '..MMM..MMMMMM..MMM..',
  '..MMM..........MMM..', '.mmmm..........mmmm.',
]
const SPRITES: Record<MobKind, string[][]> = {
  slime: [SLIME, SLIME.slice(1)], imp: IMP, skeleton: [SKELETON, SKELETON], boss: [BOSS, BOSS.slice(1)], dummy: [DUMMY, DUMMY],
}
const MOB_COLORS: Record<MobKind, Map[]> = {
  slime: [{ M: '#7bd88f', m: '#4f9e62', E: '#0b0d12' }, { M: '#b48cf2', m: '#7c5bb8', E: '#0b0d12' }, { M: '#f2a65a', m: '#b8733a', E: '#0b0d12' }],
  imp: [{ M: '#d9534f', m: '#9c3431', E: '#ffe066', h: '#f2d0a0', w: '#7a2a2a' }],
  skeleton: [{ M: '#e6e0cf', m: '#a8a290', E: '#e8615c' }],
  boss: [{ M: '#a7c79a', m: '#7a9a6e', E: '#ff4d4d', h: '#d9c9a8', s: '#4a5a44' }],
  dummy: [{ M: '#d8b46a', m: '#a8843e', E: '#5a4020', h: '#8a6a3a', w: '#6b4a2a' }],
}
const SIZE: Record<MobKind, [number, number]> = { slime: [10, 6], imp: [9, 8], skeleton: [8, 11], boss: [20, 18], dummy: [10, 13] }
const HP: Record<MobKind, number> = { slime: 4, imp: 3, skeleton: 5, boss: 1, dummy: 1 }

// Pets. Felguard and ghoul face right; imps reuse the IMP frames in their own colours.
const FELGUARD = [
  '.h.......h.', '.hhGGGGGhh.', '..GYGGGYG..', '..GGGGGGG..', '...GmmmG...', '.AAAAAAAAA.',
  'GAAaAAAaAAG', 'G.AAAAAAA.G', 'G.AaaaaaA.G', '..AA...AA..', '..GG...GG..', '.BBB...BBB.',
]
const GHOUL = [
  '..GGGG..', '.GEGGEG.', '.GGmmGG.', '..GGGG..', '.GGGGGGG', 'G.GGGG.G', 'G.GggG.G', '..GGGG..', '..G..G..', '.GG..GG.',
]
const WOLF = [
  ['........g.g.', 'G......GGGG.', '.GGGGGGGGEGn', '.GGGGGGGGGG.', '..GgggggGG..', '..G.G..G.G..', '..g.g..g.g..'],
  ['........g.g.', '.G.....GGGG.', 'G.GGGGGGGEGn', '.GGGGGGGGGG.', '..GgggggGG..', '.G..G.G..G..', '.g...g..g...'],
]
const HAWK = [
  ['w.....w', '.w.B.w.', '..BBBY.', '...b...'],
  ['.......', '.wwBww.', 'w.BBBYw', '...b...'],
]
const PET_COLORS: Record<PetKind, Map> = {
  felguard: { G: '#5fae4a', Y: '#ffe14a', h: '#3a2a1a', m: '#1e3a14', A: '#3a2b2b', a: '#5a3a3a', B: '#1e1414' },
  imp: { M: '#ff8a3d', m: '#c2551f', E: '#fff1a8', h: '#3a2a1a', w: '#8a3a1a' },
  wildimp: { M: '#b6e04a', m: '#6f9a2a', E: '#fff1a8', h: '#3a2a1a', w: '#4a6a1a' },
  wolf: { G: '#8a8f99', g: '#5d626b', E: '#ffe14a', n: '#1a1a1a' },
  hawk: { w: '#a0764a', B: '#7a5534', b: '#5a3a24', Y: '#e6b422' },
  ghoul: { G: '#8fa37a', g: '#5f6f52', E: '#9fe870', m: '#3a1a1a' },
}
const PET_BOLT: Partial<Record<PetKind, string>> = { imp: '#ff8a3d', wildimp: '#b6e04a' }
const FEL = '#8cf25c', GOLD = '#ffe98a'

const GLYPH: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'], '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'], '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'], '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'], '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'], '9': ['###', '#.#', '###', '..#', '###'],
  K: ['#.#', '##.', '#..', '##.', '#.#'], '!': ['.#.', '.#.', '.#.', '...', '.#.'],
}

// ---- world ----------------------------------------------------------------

interface Mob { kind: MobKind; x: number; y: number; hp: number; max: number; hit: number; kick: number; dying: number; tint: number; seed: number; boss: boolean; gone?: boolean }
interface Shot { x: number; y: number; target: Mob | null; aoe: boolean; by: Member; pet?: string }
interface Text { x: number; y: number; s: string; life: number; c: string; big: boolean }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; c: string; g?: number }
interface Ring { x: number; y: number; r: number; life: number; c: string }
/** `struck`: bit per party member it has already hit. */
interface Wave { x: number; life: number; kind: 'slam' | 'orb'; struck: number }
interface Pet { kind: PetKind; i: number; x: number; y: number; cd: number; strike: number; spin: number; n: number; life: number; away: number; dive: number; tx: number; ty: number; moving: boolean }
interface Drop { x: number; y: number; vy: number; life: number; kind: 'gem' | 'coin' }
interface Hero { x: number; pose: 'idle' | 'windup' | 'strike' | 'spin' | 'hurt'; poseT: number; hurt: number; jump: number }
/** One character of the party: its hero, attack rhythm and pets. */
interface Member {
  i: number
  style: HeroStyle
  hero: Hero
  // Warlocks stand further in so their imps have room behind them.
  home: number
  lane: number
  cooldown: number
  attacks: number
  pets: Pet[]
  lightning: { to: [number, number][]; life: number } | null
}

export class Battle {
  tick = 0
  private mobs: Mob[] = []
  private shots: Shot[] = []
  private texts: Text[] = []
  private sparks: Spark[] = []
  private rings: Ring[] = []
  private waves: Wave[] = []
  private drops: Drop[] = []
  private party: Member[]
  private beams: { x: number; life: number }[] = []
  private shine = 0
  private shake = 0
  private flash = 0
  private bossTimer = 60
  private telegraph = 0
  private killsAt = 0
  private packDelay = 0
  // Work scheduled on the battle's own clock (a wind-up landing two ticks later).
  private queue: { at: number; fn: () => void }[] = []
  private later(n: number, fn: () => void) { this.queue.push({ at: this.tick + n, fn }) }

  constructor(party: HeroStyle | readonly HeroStyle[], private enc: Encounter, public input: Input) {
    const styles = (Array.isArray(party) ? party : [party]).slice(0, MAX_PARTY) as HeroStyle[]
    this.party = styles.map((style, i) => {
      const home = HOME + i * 11 + (style.pets.some((k) => k === 'imp' || k === 'wildimp') ? 12 : 0)
      return {
        i, style, home, lane: LANES[i], cooldown: 8 + i * 3, attacks: 0, lightning: null,
        hero: { x: home, pose: 'idle', poseT: 0, hurt: 0, jump: 0 },
        pets: style.pets.map((kind, k) => ({
          kind, i: k, x: home + 16 + k * 6, y: GROUND - 10, cd: 6 + k * 5 + i * 2, strike: 0, spin: 0, n: 0,
          life: 60 + k * 37, away: 0, dive: 0, tx: 0, ty: 0, moving: false,
        })),
      }
    })
    this.spawn()
  }

  // ---- spawning ----
  private spawn() {
    if (this.enc.boss && !this.mobs.some((m) => m.boss)) {
      const [w, h] = SIZE[this.enc.boss]
      this.mobs.push({ kind: this.enc.boss, x: W - w - 8, y: GROUND - h, hp: 1, max: 1, hit: 0, kick: 0, dying: 0, tint: 0, seed: 0, boss: true })
    }
    const adds = this.mobs.filter((m) => !m.boss && !m.dying).length
    for (let i = adds; i < this.enc.adds; i++) {
      const kind = this.enc.addKinds[(this.tick + i * 7) % this.enc.addKinds.length]
      const [, h] = SIZE[kind]
      const lane = (i % 3) - 1
      this.mobs.push({
        kind, x: W + 2 + i * 9, y: GROUND - h + lane, hp: HP[kind], max: HP[kind], hit: 0, kick: 0, dying: 0,
        tint: Math.floor(Math.random() * MOB_COLORS[kind].length), seed: Math.random() * 10, boss: false,
      })
    }
  }

  private alive() { return this.mobs.filter((m) => !m.dying) }
  private front() {
    return this.alive().filter((m) => m.x < W - 4).sort((a, b) => a.x - b.x)[0] ?? null
  }
  private stopX(m: Mob, i: number) {
    if (m.boss) return m.x
    const boss = this.enc.boss ? W - SIZE[this.enc.boss][0] - 8 : W - 10
    return Math.min(boss - 18 - i * 12, W - 22 - i * 12)
  }

  // ---- step ----
  step() {
    const t = ++this.tick
    const due = this.queue.filter((e) => e.at <= t)
    this.queue = this.queue.filter((e) => e.at > t)
    for (const e of due) e.fn()
    const inp = this.input
    const alive = this.alive()

    // Walk-ins and spacing.
    alive.filter((m) => !m.boss).sort((a, b) => a.x - b.x).forEach((m, i) => {
      const stop = this.stopX(m, alive.filter((o) => !o.boss).length - 1 - i)
      if (m.x > stop) m.x -= m.x > W - 14 ? 3 : 1
    })
    for (const m of this.mobs) {
      if (m.hit) m.hit--
      if (m.kick > 0) { m.x += 1; m.kick-- } else if (m.kick < 0) m.kick++
      if (m.dying === 1) m.gone = true
      else if (m.dying) m.dying--
    }
    this.mobs = this.mobs.filter((m) => !m.gone)
    // Boss health is the run's remaining progress.
    const boss = this.mobs.find((m) => m.boss && !m.dying)
    if (boss) boss.hp = Math.max(0.02, this.enc.bossStart * (1 - (inp.progress ?? 0)))

    // Trash packs respawn once cleared; a boss's adds trickle back.
    if (!this.alive().some((m) => !m.boss)) {
      if (++this.packDelay > (this.enc.boss ? 30 : 10)) { this.packDelay = 0; this.spawn() }
    }
    // Every finished tenth of the run lands a kill on the front add.
    const tenth = Math.floor((inp.progress ?? 0) * 10)
    if (tenth > this.killsAt) { this.killsAt = tenth; const f = this.alive().find((m) => !m.boss); if (f) this.kill(f) }

    for (const m of this.party) { this.stepHero(m, t); this.stepPets(m, t) }
    this.stepBoss()
    this.stepShots()

    // Effects.
    this.texts = this.texts.filter((x) => { x.y -= 0.5; return --x.life > 0 })
    this.sparks = this.sparks.filter((p) => { p.x += p.vx; p.y += p.vy; p.vy += p.g ?? 0.22; return --p.life > 0 })
    this.rings = this.rings.filter((r) => { r.r += 1.4; return --r.life > 0 })
    this.drops = this.drops.filter((d) => {
      d.y = Math.min(GROUND - 3, d.y + d.vy); d.vy = d.y >= GROUND - 3 ? -d.vy * 0.4 : d.vy + 0.3
      return --d.life > 0
    })
    this.beams = this.beams.filter((b) => --b.life > 0)
    if (this.shake) this.shake--
    if (this.flash) this.flash--
    if (this.shine) this.shine--
    // A paladin sheds motes of light.
    for (const m of this.party) if (m.style.holy && t % 2) {
      this.sparks.push({ x: m.hero.x + 2 + Math.random() * 9, y: GROUND + m.lane - 2 - Math.random() * 10, vx: 0, vy: -0.3 - Math.random() * 0.3, life: 12, c: Math.random() < 0.5 ? GOLD : '#fff6d0', g: 0 })
    }
  }

  private rate() {
    return Math.min(1.8, Math.max(0.6, (this.input.speed ?? 0) > 0 ? Math.log10(this.input.speed! + 10) / 1.6 : 1))
  }

  private stepHero(m: Member, t: number) {
    const hero = m.hero
    const target = this.front()
    const melee = m.style.melee
    // A melee pet takes the front spot; the hero swings from just behind it. Melee party members queue up behind each other.
    const gap = 14 + (m.pets.some((p) => p.kind === 'ghoul' || p.kind === 'felguard' || p.kind === 'wolf') ? 9 : 0)
      + this.party.filter((o) => o.i < m.i && o.style.melee).length * 5
    const want = melee && target ? Math.max(m.home, target.x - gap) : m.home
    if (hero.x < want - 1) hero.x += 2
    else if (hero.x > want + 1) hero.x -= 2
    if (hero.jump) hero.jump--
    if (this.enc.moves && (t + m.i * 9) % 70 === 0) hero.jump = 8
    if (hero.hurt) hero.hurt--
    if (hero.poseT && --hero.poseT === 0) hero.pose = 'idle'

    // Cadence follows engine throughput, within a calm range.
    const rate = this.rate()
    if (--m.cooldown > 0 || !target || hero.hurt > 1) return
    if (melee && Math.abs(hero.x - want) > 3) return
    m.cooldown = Math.round((melee ? 7 : 9) / rate)
    m.attacks++
    const aoe = this.alive().length > 1 && m.attacks % 4 === 0
    // Wind-up, then the blow lands two ticks later.
    hero.pose = 'windup'; hero.poseT = 2
    this.later(2, () => {
      if (melee) {
        hero.pose = aoe ? 'spin' : 'strike'; hero.poseT = 3
        if (aoe) {
          this.rings.push({ x: hero.x + 6, y: GROUND + m.lane - 7, r: 3, life: 6, c: m.style.glow })
          if (m.style.holy) this.divineStorm(m)
          for (const mob of this.alive()) if (Math.abs(mob.x - hero.x) < 40) this.hit(mob, false, m)
        } else if (this.front()) {
          const f = this.front()!
          // Every third blow calls down a pillar of light.
          if (m.style.holy && m.attacks % 3 === 0) this.smite(f)
          this.hit(f, true, m)
        }
      } else {
        hero.pose = 'strike'; hero.poseT = 3
        const tgt = this.front()
        if (m.style.shot === 'lightning' || m.style.shot === 'breath') {
          if (tgt) this.instantShot(m, tgt, aoe)
        } else this.shots.push({ x: hero.x + 12, y: GROUND + m.lane - 12, target: tgt, aoe, by: m })
      }
    })
  }

  private divineStorm(m: Member) {
    const cx = m.hero.x + 6, cy = GROUND + m.lane - 7
    this.rings.push({ x: cx, y: cy, r: 6, life: 7, c: GOLD }, { x: cx, y: cy, r: 1, life: 7, c: '#ffffff' })
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2
      this.sparks.push({ x: cx, y: cy, vx: Math.cos(a) * 2.4, vy: Math.sin(a) * 1.4, life: 8, c: k % 2 ? GOLD : '#fff6d0', g: 0 })
    }
    this.shine = 2
  }

  private smite(m: Mob) {
    const cx = m.x + SIZE[m.kind][0] / 2
    this.beams.push({ x: Math.round(cx), life: 7 })
    this.rings.push({ x: cx, y: GROUND - 1, r: 3, life: 7, c: GOLD })
    for (let k = 0; k < 12; k++) this.sparks.push({ x: cx, y: GROUND - 2, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 2.6, life: 9, c: k % 3 ? GOLD : '#ffffff' })
    this.shine = 2
  }

  private stepPets(m: Member, t: number) {
    const hero = m.hero, target = this.front(), rate = this.rate()
    for (const p of m.pets) {
      if (p.strike) p.strike--
      switch (p.kind) {
        case 'felguard': case 'wolf': case 'ghoul': {
          const reach = p.kind === 'felguard' ? 11 : 9
          const want = target ? target.x - reach - p.i * 6 : hero.x + 16 + p.i * 6
          const dx = want - p.x, speed = p.kind === 'wolf' ? 3 : 2
          p.moving = Math.abs(dx) > 1
          if (p.moving) p.x += Math.sign(dx) * Math.min(speed, Math.abs(dx))
          p.y = GROUND - (p.kind === 'felguard' ? 12 : p.kind === 'ghoul' ? 10 : 7) + 1
          // Felstorm: the felguard whirls its axe through everything close.
          if (p.spin) {
            if (--p.spin % 3 === 0) {
              this.rings.push({ x: p.x + 5, y: p.y + 6, r: 4, life: 5, c: FEL })
              for (const mob of this.alive()) if (Math.abs(mob.x - p.x) < 26) this.hit(mob, false, FEL)
            }
            break
          }
          if (--p.cd > 0 || !target || Math.abs(dx) > 3) break
          p.cd = Math.round((p.kind === 'felguard' ? 11 : p.kind === 'wolf' ? 8 : 9) / rate)
          if (p.kind === 'felguard' && ++p.n % 5 === 0) { p.spin = 12; break }
          p.strike = 3
          this.later(1, () => { const f = this.front(); if (f) this.hit(f, true, PET_COLORS[p.kind].G) })
          break
        }
        case 'imp': case 'wildimp': {
          if (p.kind === 'imp') { p.x = hero.x - 11; p.y = GROUND - 20 + Math.round(Math.sin(t / 4) * 1.5) }
          else {
            p.x = hero.x - 10 + p.i * 7 + Math.round(Math.sin(t / 5 + p.i * 2) * 2)
            p.y = GROUND - 31 - ((p.i % 2) * 5) + Math.round(Math.cos(t / 3 + p.i) * 1.5)
            // Wild imps burn out and are summoned again in a puff of fel.
            if (p.away) { if (--p.away === 0) this.rings.push({ x: p.x + 4, y: p.y + 4, r: 1, life: 6, c: FEL }); break }
            if (--p.life <= 0) {
              p.life = 90 + Math.floor(Math.random() * 70); p.away = 8
              for (let k = 0; k < 10; k++) this.sparks.push({ x: p.x + 4, y: p.y + 4, vx: Math.random() * 2 - 1, vy: -Math.random() * 1.5, life: 8, c: k % 2 ? FEL : '#4a6a1a' })
              break
            }
          }
          if (--p.cd > 0 || !target) break
          p.cd = Math.round((p.kind === 'imp' ? 12 : 16) / rate)
          p.strike = 2
          this.shots.push({ x: p.x + 8, y: p.y + 3, target, aoe: false, by: m, pet: PET_BOLT[p.kind] })
          break
        }
        case 'hawk': {
          const hx = hero.x + 10 + Math.round(Math.sin(t / 7) * 10), hy = 8 + Math.round(Math.sin(t / 3) * 2)
          // A dive: five ticks down onto the target, five back up.
          if (p.dive) {
            const k = p.dive > 5 ? (10 - p.dive) / 5 : p.dive / 5
            p.x = Math.round(hx + (p.tx - hx) * k); p.y = Math.round(hy + (p.ty - hy) * k)
            if (--p.dive === 5) { const f = this.front(); if (f) this.hit(f, true, '#e6b422') }
            break
          }
          p.x = hx; p.y = hy
          if (--p.cd > 0 || !target) break
          p.cd = Math.round(26 / rate); p.dive = 10; p.tx = target.x; p.ty = target.y
          break
        }
      }
    }
  }

  private stepBoss() {
    const boss = this.mobs.find((m) => m.boss && !m.dying)
    if (!boss || !this.enc.bossAttack) return
    if (this.telegraph) {
      if (--this.telegraph === 0) {
        this.waves.push({ x: boss.x - 2, life: 40, kind: this.enc.bossAttack === 'orb' ? 'orb' : 'slam', struck: 0 })
        if (this.enc.bossAttack === 'slam') { this.shake = 3; for (let k = 0; k < 8; k++) this.sparks.push({ x: boss.x + 4 + k * 2, y: GROUND, vx: Math.random() - 0.5, vy: -Math.random() * 1.5, life: 8, c: '#8a7a5a' }) }
      }
    } else if (--this.bossTimer <= 0) { this.bossTimer = 55 + Math.floor(Math.random() * 30); this.telegraph = 9 }
    const all = (1 << this.party.length) - 1
    this.waves = this.waves.filter((w) => {
      w.x -= w.kind === 'orb' ? 2 : 3
      // It rolls through the party, striking each hero once as it passes.
      for (const { i, hero, lane } of this.party) {
        if (w.struck & (1 << i) || w.x > hero.x + 9) continue
        w.struck |= 1 << i
        if (!hero.jump) { hero.hurt = 5; hero.pose = 'hurt'; hero.poseT = 4; hero.x -= 3; this.flash = 2 }
        for (let k = 0; k < 5; k++) this.sparks.push({ x: hero.x + 6, y: GROUND + lane - 8, vx: -Math.random() * 1.5, vy: -Math.random() * 1.5, life: 7, c: '#ff6b6b' })
      }
      return w.struck !== all && --w.life > 0
    })
  }

  private stepShots() {
    this.shots = this.shots.filter((s) => {
      const tgt = s.target && !s.target.dying ? s.target : this.front()
      if (!tgt) return false
      s.target = tgt
      s.x += 5
      s.y += Math.sign(tgt.y + 3 - s.y) * 0.5
      if (s.by.style.shot === 'bolt' || s.pet) this.sparks.push({ x: s.x - 2, y: s.y + Math.random() * 2, vx: -0.3, vy: 0, life: 4, c: s.pet ?? s.by.style.glow, g: 0 })
      if (s.x >= tgt.x) {
        if (s.pet) this.hit(tgt, true, s.pet)
        else if (s.aoe) {
          this.rings.push({ x: tgt.x + 4, y: tgt.y + 3, r: 2, life: 7, c: s.by.style.glow })
          for (const m of this.alive()) if (Math.abs(m.x - tgt.x) < 30) this.hit(m, false, s.by)
        } else this.hit(tgt, true, s.by)
        return false
      }
      return s.x < W
    })
  }

  private instantShot(by: Member, tgt: Mob, aoe: boolean) {
    const targets = aoe ? this.alive() : [tgt]
    const st = by.style, hero = by.hero
    for (const m of targets) {
      if (st.shot === 'lightning') this.rings.push({ x: m.x + 4, y: m.y + 3, r: 1, life: 3, c: st.glow })
      else for (let k = 0; k < 10; k++) this.sparks.push({ x: hero.x + 12, y: GROUND + by.lane - 10, vx: 3 + Math.random() * 2, vy: (Math.random() - 0.5) * 1.2, life: Math.max(3, Math.round((m.x - hero.x) / 5)), c: k % 2 ? st.glow : '#fff1c2', g: 0 })
      this.hit(m, !aoe, by)
    }
    by.lightning = st.shot === 'lightning' ? { to: targets.map((m) => [m.x + 4, m.y + 3] as [number, number]), life: 2 } : null
  }

  /** A pet's hit (`by` its colour) flashes and sparks in that colour but shows no number: the DPS estimate is the player's. */
  private hit(m: Mob, single: boolean, by: Member | string) {
    if (typeof by === 'string') {
      const pet = by
      m.hit = 1
      if (!m.boss) m.kick = 1
      for (let k = 0; k < 3; k++) this.sparks.push({ x: m.x + 2, y: m.y + 3, vx: Math.random() * 1.6 - 0.3, vy: -Math.random() * 1.4, life: 5, c: pet })
      if (!m.boss) { m.hp -= 0.5; if (m.hp <= 0) this.kill(m) }
      return
    }
    const crit = by.attacks % 6 === 0 && single
    const d = this.input.dps
    const s = (d && d > 0 ? `${Math.max(1, Math.round(d / 1000))}K` : `${2 + (by.attacks % 7)}K`) + (crit ? '!' : '')
    const stack = this.texts.filter((t) => t.life > 8).length
    // A party lands many blows at once: a number only while there is room for it, but a crit always shows.
    if (stack < 3 || crit) this.texts.push({ x: Math.min(W - 4 * s.length - 2, m.x - 2 + Math.random() * 8), y: m.y - 6 - (stack % 3) * 6, s, life: crit ? 16 : 12, c: crit ? '#ffd166' : '#eef3f8', big: crit })
    m.hit = m.boss ? 1 : 2
    if (!m.boss) m.kick = crit ? 3 : 1
    for (let k = 0; k < (crit ? 10 : 4); k++) this.sparks.push({ x: m.x + 2, y: m.y + 3, vx: Math.random() * 2 - 0.4, vy: -Math.random() * 1.8, life: 6, c: crit ? '#ffd166' : by.style.glow })
    if (crit) { this.shake = 2; this.rings.push({ x: m.x + 4, y: m.y + 4, r: 1, life: 5, c: '#ffd166' }); if (by.style.holy) this.shine = 2 }
    if (!m.boss) { m.hp -= crit ? 2 : 1; if (m.hp <= 0) this.kill(m) }
  }

  private kill(m: Mob) {
    if (m.dying) return
    const c = MOB_COLORS[m.kind][m.tint]
    for (let k = 0; k < 14; k++) this.sparks.push({ x: m.x + Math.random() * SIZE[m.kind][0], y: m.y + Math.random() * SIZE[m.kind][1], vx: Math.random() * 3 - 1.2, vy: -Math.random() * 2.4, life: 10, c: k % 3 ? c.M : c.m })
    this.rings.push({ x: m.x + 5, y: m.y + 4, r: 2, life: 6, c: c.M })
    m.dying = 6
    if (this.enc.loot && Math.random() < 0.5) this.drops.push({ x: m.x + 3, y: m.y, vy: -2, life: 36, kind: this.enc.loot })
  }

  // ---- draw ----
  draw(ctx: CanvasRenderingContext2D) {
    ctx.save()
    ctx.clearRect(0, 0, W, H)
    this.drawGraph(ctx)
    if (this.shake) ctx.translate(this.tick % 2 ? 1 : -1, 0)
    // Ground and dust stripes.
    ctx.fillStyle = 'rgb(255 255 255 / 0.1)'
    ctx.fillRect(0, GROUND + 1, W, 1)
    ctx.fillStyle = 'rgb(255 255 255 / 0.05)'
    for (let x = -(this.tick % 14); x < W; x += 14) ctx.fillRect(x + 4, GROUND + 3, 4, 1)

    for (const w of this.waves) {
      if (w.kind === 'orb') { px(ctx, w.x, GROUND - 9, 3, 3, '#b06cff'); px(ctx, w.x + 3, GROUND - 8, 2, 1, 'rgb(176 108 255 / 0.4)') }
      else { px(ctx, w.x, GROUND - 2, 2, 2, '#c8b89a'); px(ctx, w.x + 2, GROUND - 1, 3, 1, 'rgb(200 184 154 / 0.5)') }
    }
    for (const b of this.beams) {
      const w = b.life > 4 ? 7 : b.life > 2 ? 5 : 3
      px(ctx, b.x - Math.floor(w / 2), 0, w, GROUND + 1, withAlpha(GOLD, 0.12 + b.life * 0.03))
      px(ctx, b.x - 1, 0, 2, GROUND + 1, b.life > 2 ? '#fffbe6' : withAlpha(GOLD, 0.6))
    }
    for (const m of [...this.mobs].sort((a, b) => a.y - b.y)) this.drawMob(ctx, m)
    const pets = this.party.flatMap((m) => m.pets)
    for (const p of pets) if (p.kind === 'imp' || p.kind === 'wildimp' || p.kind === 'hawk') this.drawPet(ctx, p)
    // Back row first.
    for (const m of [...this.party].sort((a, b) => a.lane - b.lane)) this.drawHero(ctx, m)
    for (const p of pets) if (p.kind === 'felguard' || p.kind === 'wolf' || p.kind === 'ghoul') this.drawPet(ctx, p)
    for (const s of this.shots) this.drawShot(ctx, s)
    for (const m of this.party) if (m.lightning && m.lightning.life-- > 0) {
      for (const [tx, ty] of m.lightning.to) zigzag(ctx, m.hero.x + 11, GROUND + m.lane - 13, tx, ty, m.style.glow)
    }
    for (const r of this.rings) ring(ctx, r.x, r.y, r.r, r.c, r.life / 7)
    for (const p of this.sparks) px(ctx, Math.round(p.x), Math.round(p.y), 1, 1, p.c)
    for (const d of this.drops) this.drawDrop(ctx, d)
    for (const x of this.texts) text(ctx, x.s, Math.round(x.x), Math.round(x.y), x.c, x.life)
    ctx.restore()
    if (this.flash) { ctx.fillStyle = 'rgb(255 80 80 / 0.12)'; ctx.fillRect(0, 0, W, H) }
    if (this.shine) { ctx.fillStyle = withAlpha(GOLD, 0.07 * this.shine); ctx.fillRect(0, 0, W, H) }
  }

  private drawGraph(ctx: CanvasRenderingContext2D) {
    const s = this.input.samples
    if (s.length < 2) return
    const lo = Math.min(...s.map((v) => v.mean * (1 - v.err / 100)))
    const hi = Math.max(...s.map((v) => v.mean * (1 + v.err / 100)))
    const span = hi - lo || 1
    const y = (v: number) => Math.round(4 + (1 - (v - lo) / span) * (GROUND - 14))
    let prev: number | null = null
    for (let x = 0; x < W; x++) {
      // Averaged over neighbouring samples so the trace reads as a trend, not noise.
      const c = (x / (W - 1)) * (s.length - 1)
      const win = s.slice(Math.max(0, Math.round(c) - 2), Math.round(c) + 3)
      const v = { mean: win.reduce((a, b) => a + b.mean, 0) / win.length, err: win.reduce((a, b) => a + b.err, 0) / win.length }
      const top = y(v.mean * (1 + v.err / 100)), bottom = y(v.mean * (1 - v.err / 100)), mid = y(v.mean)
      px(ctx, x, top, 1, Math.max(1, bottom - top), 'rgb(101 203 229 / 0.045)')
      const from = prev ?? mid
      px(ctx, x, Math.min(from, mid), 1, Math.abs(mid - from) + 1, 'rgb(101 203 229 / 0.13)')
      prev = mid
    }
  }

  private drawHero(ctx: CanvasRenderingContext2D, m: Member) {
    const h = m.hero, st = m.style
    const jumpY = h.jump ? -Math.round(Math.sin((h.jump / 8) * Math.PI) * 6) : 0
    const bob = h.pose === 'idle' && Math.floor(this.tick / 6) % 2 ? 1 : 0
    const lean = h.pose === 'strike' ? 2 : h.pose === 'windup' ? -1 : h.pose === 'hurt' ? -2 : 0
    const x = Math.round(h.x + lean), y = GROUND + m.lane - 14 + bob + jumpY
    const hurt = h.hurt > 0 && h.hurt % 2
    const map: Map = hurt
      ? { A: '#ff8a8a', a: '#d45a5a', T: '#ffd0d0', D: '#ff8a8a', d: '#d45a5a', S: '#ffd0d0', E: '#5a0000', B: '#7a2a2a', h: '#ffb0b0' }
      : { A: st.armor, a: st.shade, T: st.trim, D: st.headColor, d: st.shade, S: '#f1c7a5', E: '#0b0d12', B: '#1e2433', h: '#e0d6b8' }
    // Ground shadow.
    px(ctx, x + 2, GROUND + m.lane, 8 - Math.min(4, -jumpY), 1, 'rgb(0 0 0 / 0.35)')
    if (h.pose === 'windup' || h.pose === 'strike') ring(ctx, x + 6, y + 8, h.pose === 'windup' ? 5 : 7, st.glow, 0.25)
    // Paladin: a pulsing halo and a soft golden aura.
    if (st.holy) {
      ring(ctx, x + 6, y - 1, 4, GOLD, 0.45 + 0.25 * Math.sin(this.tick / 3))
      ring(ctx, x + 6, y + 7, 9 + (this.tick % 12 < 6 ? 0 : 1), GOLD, 0.14)
    }
    sprite(ctx, HEADS[st.head], x, y, map)
    sprite(ctx, BODY, x, y + 5, map)
    this.drawWeapon(ctx, m, x + 10, y + 8)
  }

  private drawWeapon(ctx: CanvasRenderingContext2D, m: Member, hx: number, hy: number) {
    const st = m.style, pose = m.hero.pose
    const up = pose === 'windup', hit = pose === 'strike' || pose === 'spin'
    const metal = '#d8dde6', wood = '#8a6a44'
    switch (st.weapon) {
      case 'staff': case 'wand': {
        const len = st.weapon === 'staff' ? 12 : 5
        px(ctx, hx, hy - len + 3 - (up ? 2 : 0), 1, len, wood)
        const s = hit ? 3 : 2
        px(ctx, hx - (s - 1) / 2, hy - len + 1 - (up ? 2 : 0), s, s, hit ? '#ffffff' : st.glow)
        if (hit) ring(ctx, hx, hy - len + 2, 3, st.glow, 0.6)
        break
      }
      case 'bow': {
        const pull = up ? 2 : 0
        for (let i = -5; i <= 5; i++) px(ctx, hx + 1 + (Math.abs(i) < 3 ? 1 : 0), hy + i - 2, 1, 1, wood)
        for (let i = -4; i <= 4; i++) px(ctx, hx + (i === 0 ? -pull : 0), hy + i - 2, 1, 1, 'rgb(255 255 255 / 0.6)')
        if (up) px(ctx, hx - 2, hy - 2, 6, 1, st.glow)
        break
      }
      case 'fists': case 'claws':
        px(ctx, hx + (hit ? 3 : 0), hy, 2, 2, hit ? st.glow : '#f1c7a5')
        if (st.weapon === 'claws' && hit) for (let i = 0; i < 3; i++) px(ctx, hx + 5, hy - 2 + i * 2, 3, 1, st.glow)
        break
      case 'daggers':
        if (hit) { px(ctx, hx + 1, hy, 5, 1, metal); px(ctx, hx - 1, hy + 3, 5, 1, metal) }
        else { px(ctx, hx, hy - 3, 1, 4, metal); px(ctx, hx - 8, hy - 2, 1, 4, metal) }
        break
      case 'glaives':
        for (const dx of [0, -9]) { px(ctx, hx + dx, hy - (hit ? 0 : 3), 1, 5, st.glow); px(ctx, hx + dx + 1, hy - (hit ? -2 : 3), 2, 1, st.glow) }
        break
      case 'greatsword': {
        // Two-handed: rests on the shoulder, hauls back overhead, sweeps level.
        const [dx, dy] = up ? [-0.8, -0.6] : hit ? [1, 0] : [0.3, -1]
        const edge = st.holy ? '#fff1b0' : '#ffffff'
        for (let i = 2; i <= 14; i++) {
          const bx = Math.round(hx + dx * i), by = Math.round(hy + dy * i)
          px(ctx, bx, by, 2, 2, metal)
          if (i % 2) px(ctx, bx, by, 1, 1, edge)
          if (st.holy && (hit || up)) px(ctx, bx + (hit ? 0 : 2), by - (hit ? 1 : 0), 1, 1, withAlpha(GOLD, 0.7))
        }
        px(ctx, hx - 1, hy - 1, 4, 3, '#e6b422')
        px(ctx, Math.round(hx - dx * 2), Math.round(hy - dy * 2), 2, 2, st.trim)
        if (hit) px(ctx, Math.round(hx + dx * 15), Math.round(hy + dy * 15) - 1, 1, 3, '#ffffff')
        break
      }
      default: {
        // sword, hammer, spear
        const long = st.weapon === 'spear' ? 10 : 7
        if (up) for (let i = 1; i <= long; i++) px(ctx, hx - i + 2, hy - i, 1, 1, metal)
        else if (hit) for (let i = 1; i <= long + 1; i++) px(ctx, hx + i, hy - 1, 1, 1, metal)
        else for (let i = 1; i <= long; i++) px(ctx, hx + 1, hy - i, 1, 1, metal)
        px(ctx, hx - 1, hy, 3, 1, st.trim)
        if (st.weapon === 'hammer') px(ctx, hit ? hx + long : hx - 1, hit ? hy - 3 : hy - long - 2, 4, 4, '#b0b6c2')
      }
    }
    // Swing arc on a melee strike, whirl on a spin.
    if (st.melee && hit) {
      const big = st.weapon === 'greatsword'
      const r = pose === 'spin' ? (big ? 14 : 11) : big ? 13 : 8
      for (let a = pose === 'spin' ? 0 : -1.2; a < (pose === 'spin' ? Math.PI * 2 : 1.2); a += big ? 0.15 : 0.25) {
        for (const rr of big ? [r, r - 1] : [r]) px(ctx, Math.round(hx - 4 + Math.cos(a) * rr), Math.round(hy - 2 + Math.sin(a) * rr * 0.8), 1, 1, a > 0.4 ? st.glow : '#ffffff')
      }
    }
  }

  private drawPet(ctx: CanvasRenderingContext2D, p: Pet) {
    const map = PET_COLORS[p.kind], t = this.tick
    const x = Math.round(p.x), y = Math.round(p.y)
    switch (p.kind) {
      case 'felguard': {
        const lunge = p.strike ? 2 : 0
        px(ctx, x + 1, GROUND + 1, 9, 1, 'rgb(0 0 0 / 0.35)')
        sprite(ctx, FELGUARD, x + lunge, y + (p.moving && t % 4 < 2 ? -1 : 0), map)
        const ax = x + 10 + lunge, ay = y + 6
        if (p.spin) {
          // Felstorm: the axe whirls round him in fel green.
          const a = t * 1.3
          for (let k = 0; k < 3; k++) px(ctx, Math.round(x + 5 + Math.cos(a + k * 2.1) * 8), Math.round(y + 6 + Math.sin(a + k * 2.1) * 5), 2, 2, k ? FEL : '#d8dde6')
          ring(ctx, x + 5, y + 6, 9, FEL, 0.5)
        } else if (p.strike) { px(ctx, ax, ay, 8, 1, '#6b4a2a'); px(ctx, ax + 6, ay - 3, 3, 6, '#9aa3ad'); px(ctx, ax + 8, ay - 3, 1, 6, '#e8ecf2') }
        else { px(ctx, ax, ay - 7, 1, 9, '#6b4a2a'); px(ctx, ax + 1, ay - 7, 3, 4, '#9aa3ad'); px(ctx, ax + 3, ay - 7, 1, 4, '#e8ecf2') }
        break
      }
      case 'ghoul': {
        const lunge = p.strike ? 3 : 0
        px(ctx, x + 1, GROUND + 1, 6, 1, 'rgb(0 0 0 / 0.35)')
        sprite(ctx, GHOUL, x + lunge, y + (t % 6 < 3 ? 0 : 1), map)
        if (p.strike) for (let i = 0; i < 3; i++) px(ctx, x + lunge + 9 + i, y + 3 + i * 2, 3, 1, '#9fe870')
        break
      }
      case 'wolf': {
        const run = p.moving || p.strike ? Math.floor(t / 2) % 2 : 0
        px(ctx, x + 1, GROUND + 1, 10, 1, 'rgb(0 0 0 / 0.35)')
        sprite(ctx, WOLF[run], x + (p.strike ? 3 : 0), y - (p.strike === 2 ? 2 : 0), map)
        if (p.strike === 2) px(ctx, x + 14, y + 2, 2, 1, '#ffffff')
        break
      }
      case 'imp': case 'wildimp': {
        if (p.kind === 'wildimp' && p.away) break
        sprite(ctx, IMP[Math.floor(t / 2 + p.i) % 2], x, y, map)
        // Casting: a flicker of flame between its hands.
        if (p.strike) { px(ctx, x + 8, y + 3, 2, 2, map.M); px(ctx, x + 8, y + 3, 1, 1, '#ffffff') }
        break
      }
      case 'hawk':
        sprite(ctx, HAWK[p.dive ? 0 : Math.floor(t / 2) % 2], x, y, map)
        break
    }
  }

  private drawShot(ctx: CanvasRenderingContext2D, s: Shot) {
    const c = s.pet ?? s.by.style.glow
    if (s.pet) { px(ctx, s.x - 1, s.y - 1, 3, 3, withAlpha(c, 0.35)); px(ctx, s.x, s.y, 2, 2, c); px(ctx, s.x, s.y, 1, 1, '#ffffff'); return }
    if (s.by.style.shot === 'arrow') { px(ctx, s.x - 5, s.y + 1, 6, 1, '#c8b08a'); px(ctx, s.x + 1, s.y, 2, 3, '#e6e0cf') }
    else { px(ctx, s.x - 1, s.y - 1, 4, 4, withAlpha(c, 0.35)); px(ctx, s.x, s.y, 2, 2, '#ffffff'); px(ctx, s.x - 3, s.y + 1, 3, 1, c) }
  }

  private drawMob(ctx: CanvasRenderingContext2D, m: Mob) {
    const frames = SPRITES[m.kind]
    const f = frames[Math.floor((this.tick + m.seed) / (m.kind === 'imp' ? 3 : 5)) % frames.length]
    const squish = frames[0].length - f.length
    const base = MOB_COLORS[m.kind][m.tint]
    const map: Map = m.hit ? Object.fromEntries(Object.keys(base).map((k) => [k, '#ffffff'])) : base
    const x = Math.round(m.x), y = Math.round(m.y) + squish
    const [w] = SIZE[m.kind]
    if (m.dying) { if (m.dying % 2) sprite(ctx, f, x, y, Object.fromEntries(Object.keys(base).map((k) => [k, 'rgb(255 255 255 / 0.5)']))); return }
    px(ctx, x + 1, GROUND, w - 2, 1, 'rgb(0 0 0 / 0.35)')
    // Boss wind-up: rears back and a "!" blinks overhead.
    const rear = m.boss && this.telegraph ? -1 : 0
    sprite(ctx, f, x + rear, y + (m.boss && this.telegraph ? -1 : 0), map)
    if (m.boss && this.telegraph && this.tick % 2) text(ctx, '!', x + w / 2 - 1, y - 12, '#ff6b6b', 10)
    // Health bar: boss bars are wide and track the run.
    const bw = m.boss ? w : Math.min(w, 10)
    px(ctx, x, y - 4, bw, 2, 'rgb(0 0 0 / 0.55)')
    px(ctx, x, y - 4, Math.max(0, Math.round((m.hp / m.max) * bw)), 2, m.boss ? '#e8615c' : '#ff8a6a')
  }

  private drawDrop(ctx: CanvasRenderingContext2D, d: Drop) {
    const blink = d.life < 10 && d.life % 2
    if (blink) return
    if (d.kind === 'gem') { px(ctx, d.x + 1, d.y, 1, 1, '#e3c4ff'); px(ctx, d.x, d.y + 1, 3, 1, '#a335ee'); px(ctx, d.x + 1, d.y + 2, 1, 1, '#7a1fb8') }
    else { px(ctx, d.x, d.y, 3, 3, '#e6b422'); px(ctx, d.x + 1, d.y + 1, 1, 1, '#fff1a8') }
    if (this.tick % 6 === 0) this.sparks.push({ x: d.x + 1, y: d.y - 1, vx: 0, vy: -0.4, life: 4, c: '#ffffff', g: 0 })
  }
}

// ---- drawing helpers ------------------------------------------------------

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c
  ctx.fillRect(x, y, w, h)
}
function sprite(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, map: Map) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = map[row[i]]
      if (c) px(ctx, x + i, y + j, 1, 1, c)
    }
  })
}
function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, c: string, life: number) {
  ctx.globalAlpha = Math.min(1, life / 5)
  ;[...s].forEach((ch, k) => GLYPH[ch]?.forEach((row, j) => [...row].forEach((p, i) => {
    if (p === '#') { px(ctx, x + k * 4 + i + 1, y + j + 1, 1, 1, 'rgb(0 0 0 / 0.6)'); px(ctx, x + k * 4 + i, y + j, 1, 1, c) }
  })))
  ctx.globalAlpha = 1
}
function ring(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, c: string, alpha: number) {
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
  for (let a = 0; a < Math.PI * 2; a += 0.35) px(ctx, Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.7), 1, 1, c)
  ctx.globalAlpha = 1
}
function zigzag(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, c: string) {
  const steps = Math.max(2, Math.round((x1 - x0) / 5))
  let px0 = x0, py0 = y0
  for (let i = 1; i <= steps; i++) {
    const nx = Math.round(x0 + ((x1 - x0) * i) / steps), ny = Math.round(y0 + ((y1 - y0) * i) / steps + (i < steps ? (Math.random() - 0.5) * 6 : 0))
    const n = Math.max(Math.abs(nx - px0), Math.abs(ny - py0))
    for (let k = 0; k <= n; k++) px(ctx, Math.round(px0 + ((nx - px0) * k) / n), Math.round(py0 + ((ny - py0) * k) / n), 1, 1, k % 3 ? c : '#ffffff')
    px0 = nx; py0 = ny
  }
}
function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / ${a})`
}
