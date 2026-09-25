#!/usr/bin/env python3
"""Regenerate the Power Infusion chart data (CLAUDE.md D13).

Sims every spec's base upstream profile at 1-10 targets, with and without an external Power
Infusion, through the node CLI relink of the locked engine (scripts/engine-smoke.sh). Offline,
shared reference data; never user data. Writes src/lib/catalog/generated/power-infusion.json
(the chart) and one pi-detail/pi-detail-<profile>.json per spec (the drawer: each variant's
report, trimmed to what the app's own parser, src/lib/simc/detail.ts, reads).

For a new patch:
  1. bump engine.lock.json to the new upstream commit
  2. npm run engine:bootstrap
  3. source ~/emsdk/emsdk_env.sh && npm run engine:build
  4. python3 scripts/generate_power_infusion.py [--tier MID3]    (or: npm run data:power-infusion)

The script refuses to run when vendor/simc or the built engine is not at the locked commit.
It rewrites the output after every spec; a rerun with the same engine and settings skips
finished specs, so an interrupted run resumes.

In a terminal it shows a live dashboard: progress, time left, the sims running now, every
spec's progress by target count, and the machine's CPU and memory. Keys:
  p  pause or resume (running sims finish; no new ones start)
  +  -  more or fewer sims side by side
  q  stop after the running sims (finished specs are kept); q again stops now
Piped or with --plain it prints one line per sim instead.

Runs on macOS, Linux and Windows: the engine runs as `node build/wasm/simc-node.cjs`, relinked
with em++ (emsdk) only when missing or older than the build. The build (step 3) needs bash and
emsdk. A machine without them, Windows for one, can skip it: copy build/wasm/simc-node.cjs and
build/wasm/simc-node.wasm from a machine that built them (WebAssembly runs anywhere), run
`npm run engine:bootstrap`, then this script (`py` on Windows). Every report's engine commit is
checked against engine.lock.json, so a stale copy fails on its first sim.

Options: --target-error 0.1  --jobs 3  --tier MID2  --specs "Marksmanship Hunter,Outlaw Rogue"
         --out file.json  --plain
Standard library only; Python 3.9+.
"""
from __future__ import annotations

import argparse
import collections
import ctypes
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src/lib/catalog/generated/power-infusion.json'
DETAIL = 'pi-detail'  # dir beside OUT and file prefix; vite.config.ts keeps these chunks out of the SW precache
BUILD = ROOT / 'build/wasm'
CLI = BUILD / 'simc-node.cjs'  # .cjs: the glue is CommonJS; .mjs makes emscripten infer ES6 and exit 0
EMSDK = Path(os.environ.get('EMSDK') or Path.home() / 'emsdk')
WINDOWS = os.name == 'nt'

FIGHT_STYLE = 'CastingPatchwerk'
TARGETS = list(range(1, 11))
# APL-driven: the spec's own invoke_external_buff line decides when (player.cpp:10943-10998).
PI_POOL = 'external_buffs.pool=power_infusion:120:1'
# No APL line: on cooldown from pull. Times past the fight end never fire (player.cpp:13492-13509).
PI_TIMED = 'external_buffs.power_infusion=0/120/240/360'
# Actor options that switch an APL into priority-target play. Verified at c01572044af5:
# sc_hunter.cpp:9011 (default on), sc_rogue.cpp:11308 (default off). No generic equivalent
# exists: simc cannot make an arbitrary APL ignore extra targets.
FUNNEL_TOGGLES = ['max_prio_damage', 'priority_rotation']
# Second-row AoE talent builds for specs whose upstream profile is a single-target build.
AOE_BUILDS = json.loads((ROOT / 'scripts/pi-aoe-builds.json').read_text())['builds']
# Buffs the drawer draws as bands over the damage timeline.
BANDS = ('power_infusion', 'bloodlust')


def title(token: str) -> str:
    return ' '.join(w[:1].upper() + w[1:] for w in token.split('_'))


def pick_profiles(files: list[tuple[str, str]]) -> list[dict]:
    """One base profile per spec: the shortest filename, i.e. not a hero-talent variant."""
    by_spec: dict[str, dict] = {}
    for file, text in files:
        cls = re.search(r'^(\w+)="', text, re.M)
        spec = re.search(r'^spec=(\w+)', text, re.M)
        if not cls or not spec:
            raise ValueError(f'{file}: no class or spec line')
        base = file[:-len('.simc')] if file.endswith('.simc') else file
        # Display class from the filename (death_knight), not the actor token (deathknight).
        at = base.lower().find(f'_{spec.group(1)}')
        if at < 0:
            raise ValueError(f'{file}: spec {spec.group(1)} not in filename')
        name = f'{title(spec.group(1))} {title(base[base.index("_") + 1:at].lower())}'
        prev = by_spec.get(name)
        if not prev or len(base) < len(prev['profile']):
            by_spec[name] = {'name': name, 'profile': base, 'text': text}
    out = []
    for s in sorted(by_spec.values(), key=lambda s: s['name']):
        text = s['text']
        out.append({
            'name': s['name'],
            'profile': s['profile'],
            'piTiming': 'apl' if 'invoke_external_buff,name=power_infusion' in text else 'cooldown',
            'funnel': next((t for t in FUNNEL_TOGGLES if re.search(rf'\b{t}\b', text)), None),
            'aoe': s['profile'] in AOE_BUILDS,
        })
    return out


PAIRS = {'base': ('base', 'pi'), 'funnel': ('funnel', 'funnelPi'), 'aoe': ('aoe', 'aoePi')}


def variants(spec: dict, targets: int, only: tuple = tuple(PAIRS)) -> list[str]:
    """base and pi always; above one target, funnel specs add their funnel-on pair and AoE-build specs their AoE pair.
    only: the pairs to run (--variants), for a partial run merged into earlier ones."""
    multi = targets > 1
    have = ['base'] + (['funnel'] if spec['funnel'] and multi else []) + (['aoe'] if spec.get('aoe') and multi else [])
    return [v for pair in have if pair in only for v in PAIRS[pair]]


def run_args(spec: dict, targets: int, variant: str, *, target_error: float, threads: int,
             profile_path: str, json_path: str) -> list[str]:
    """Engine args for one variant: its own full run, so its report feeds the drawer."""
    args = [profile_path]
    toggle = spec['funnel']
    # Explicit off, so a default-on toggle (hunters) still gets a spread baseline.
    if toggle:
        args.append(f"{toggle}={1 if variant in ('funnel', 'funnelPi') else 0}")
    if variant in ('aoe', 'aoePi'):
        build = AOE_BUILDS[spec['profile']]['3' if targets < 5 else '5']
        args += [f'{k}={v}' for k, v in build.items()]  # after the profile, so they replace its lines
    if variant in ('pi', 'funnelPi', 'aoePi'):
        args.append(PI_POOL if spec['piTiming'] == 'apl' else PI_TIMED)
    return args + [
        f'fight_style={FIGHT_STYLE}',
        f'desired_targets={targets}',
        f'target_error={target_error}',
        f'threads={threads}',
        f'json={json_path},version=2',
    ]


def _num(x: float, digits: int = 1) -> float | int:
    v = round(x, digits)
    return int(v) if float(v).is_integer() else v


def pair(mean: float, sd: float) -> list:
    return [_num(mean), _num(sd)]


def trim_stat(s: dict) -> dict | None:
    """One stats[] entry, keeping only the keys detail.ts reads. Drops what damageBreakdown drops:
    a non-damage stat survives only as the parent of damage children."""
    kids = [k for k in map(trim_stat, s.get('children', [])) if k]
    if s.get('type') != 'damage' and not kids:
        return None
    out = {k: s[k] for k in ('name', 'spell_name', 'id', 'item_id', 'school', 'type') if k in s}
    for key, digits in (('portion_apse', 1), ('portion_aps', 1), ('actual_amount', 0),
                        ('num_executes', 2), ('num_ticks', 2)):
        if isinstance(s.get(key), dict) and 'mean' in s[key]:
            out[key] = {'mean': _num(s[key]['mean'], digits)}
    if 'compound_amount' in s:
        out['compound_amount'] = _num(s['compound_amount'], 0)
    for key in ('direct_results', 'tick_results'):
        if key in s:
            out[key] = {r: {'count': {'sum': _num(v['count']['sum'], 0)}}
                        for r, v in s[key].items() if 'count' in v}
    if kids:
        out['children'] = kids
    return out


def trim_player(p: dict) -> dict:
    """A report's player, cut to the damage breakdown, the damage timeline and the band buffs."""
    stats = lambda xs: [t for t in map(trim_stat, xs or []) if t]
    pets = {k: v for k, v in ((k, stats(v)) for k, v in (p.get('stats_pets') or {}).items()) if v}
    cd = p['collected_data']
    tl = cd['timeline_dmg']
    buffs = []
    for b in p.get('buffs', []):
        if b['name'] in BANDS:
            keep = {k: b[k] for k in ('name', 'spell_name', 'spell', 'start_count', 'uptime',
                                      'interval', 'duration') if k in b}
            # Share of iterations with the buff up, per second of the fight (report_json.cpp:184).
            keep['stack_uptime'] = {'data': [_num(v, 2) for v in b['stack_uptime']['data']]}
            buffs.append(keep)
    return {
        'name': p['name'],
        'stats': stats(p['stats']),
        'stats_pets': pets,
        'buffs': buffs,
        'collected_data': {
            'dps': {'mean': _num(cd['dps']['mean'])},
            'timeline_dmg': {**{k: _num(tl[k]) for k in ('mean', 'min', 'max')},
                             'data': [round(v) for v in tl['data']]},
        },
    }


def check_engine(report: dict, commit: str, version: str) -> None:
    """Fail on a report from any engine but the locked one (a stale or foreign copied CLI)."""
    rev = report.get('git_revision') or ''
    if len(rev) < 7 or not commit.startswith(rev) or report.get('version') != version:
        raise RuntimeError(f"engine is simc {report.get('version')} at {rev or 'an unknown commit'}, "
                           f'lock says {version} at {commit[:10]}. Rebuild or recopy build/wasm/simc-node.*')


def extract_variant(report: dict) -> tuple[dict, dict]:
    """simc json2 -> ({dps: [mean, sd], prio: [mean, sd]}, trimmed player)."""
    players = report['sim']['players']
    if len(players) != 1:
        raise ValueError(f'expected one player, got {len(players)}')
    cd = players[0]['collected_data']
    # prioritydps is only written above one target (report_json.cpp:575); at one target it equals dps.
    prio = cd.get('prioritydps', cd['dps'])
    return ({'dps': pair(cd['dps']['mean'], cd['dps']['mean_std_dev']),
             'prio': pair(prio['mean'], prio['mean_std_dev'])}, trim_player(players[0]))

# ---------------------------------------------------------------------------------------------
# Engine


def relink(pool: int) -> None:
    """Link the browser build's objects as a node CLI (what scripts/engine-smoke.sh does), once.

    With no build tree, a node CLI copied from another machine is used as is: it is WebAssembly, so
    one built on macOS runs on Windows. check_engine() holds every report to the locked commit.
    """
    lib = BUILD / 'engine/libengine.a'
    if not lib.exists():
        if CLI.exists() and CLI.with_suffix('.wasm').exists():
            return
        sys.exit('no engine. Either build it (npm run engine:build, needs emsdk and bash), or copy\n'
                 'build/wasm/simc-node.cjs and build/wasm/simc-node.wasm from a machine that has.')
    if CLI.exists() and CLI.stat().st_mtime >= lib.stat().st_mtime:
        return
    threads = ['-pthread', f'-sPTHREAD_POOL_SIZE={pool}']
    cmd = ['em++', '-O3', '-fwasm-exceptions', *threads,
           str(BUILD / 'CMakeFiles/simc.dir/engine/sc_main.cpp.o'), str(lib), '-o', str(CLI),
           '-fwasm-exceptions', *threads, '-sINITIAL_MEMORY=134217728', '-sALLOW_MEMORY_GROWTH=1',
           '-sMAXIMUM_MEMORY=4gb', '-sENVIRONMENT=node,worker', '-sNODERAWFS=1', '-sEXIT_RUNTIME=1']
    print(f'relinking the engine as a node CLI (pool {pool})...', flush=True)
    if shutil.which('em++'):
        proc = subprocess.run(cmd, cwd=ROOT)
    elif WINDOWS:
        proc = subprocess.run(f'call "{EMSDK / "emsdk_env.bat"}" >nul 2>&1 && {subprocess.list2cmdline(cmd)}',
                              shell=True, cwd=ROOT)
    else:
        proc = subprocess.run(['bash', '-c', 'source "$0" >/dev/null 2>&1 && exec "$@"',
                               str(EMSDK / 'emsdk_env.sh'), *cmd], cwd=ROOT)
    if proc.returncode != 0:
        sys.exit(f'relink failed. Put em++ on PATH, or set EMSDK to your emsdk directory (now {EMSDK}).')


PROCS: set = set()  # running engine processes, killed on a hard stop
PROCS_LOCK = threading.Lock()


def engine(node: str, args: list[str]) -> tuple[int, str]:
    proc = subprocess.Popen([node, str(CLI), *args], cwd=ROOT, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    with PROCS_LOCK:
        PROCS.add(proc)
    try:
        out, _ = proc.communicate(timeout=60 * 60)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
    finally:
        with PROCS_LOCK:
            PROCS.discard(proc)
    return proc.returncode, out


def kill_engines() -> None:
    with PROCS_LOCK:
        for proc in PROCS:
            proc.kill()


def preflight(lock: dict, manifest: dict) -> None:
    commit = lock['upstream']['commit']
    head = subprocess.run(['git', '-C', str(ROOT / 'vendor/simc'), 'rev-parse', 'HEAD'],
                          capture_output=True, text=True).stdout.strip()
    if head != commit:
        sys.exit(f'vendor/simc is at {head or "nothing"}, lock says {commit}. Run: npm run engine:bootstrap')
    built = manifest['engine']['upstreamCommit']
    if built != commit:
        sys.exit(f'engine manifest says {built}, lock says {commit}. Run: npm run engine:build')


# ---------------------------------------------------------------------------------------------
# Scheduler: every (spec, targets, variant) sim is one task; a spec is written when its last lands.

Task = collections.namedtuple('Task', 'spec targets variant')


class Runner:
    def __init__(self, tasks: list, run_one, on_spec, jobs: int, max_jobs: int):
        self.pending = collections.deque(tasks)
        self.total = len(tasks)
        self.left = collections.Counter(t.spec['name'] for t in tasks)
        self.results: dict = {}
        self.running: dict = {}   # worker -> (task, started)
        self.done: list = []      # (task, seconds, value)
        self.errors: list = []    # (task or None, message)
        self.run_one, self.on_spec = run_one, on_spec
        self.jobs, self.max_jobs = max(1, min(jobs, max_jobs)), max_jobs
        self.paused = self.stopping = False
        self.started = time.monotonic()
        self.cond = threading.Condition()
        self.workers = [threading.Thread(target=self._work, args=(i,), daemon=True) for i in range(max_jobs)]

    def start(self) -> 'Runner':
        for w in self.workers:
            w.start()
        return self

    def alive(self) -> bool:
        return any(w.is_alive() for w in self.workers)

    def set_jobs(self, n: int) -> None:
        with self.cond:
            self.jobs = max(1, min(n, self.max_jobs))
            self.cond.notify_all()

    def pause(self) -> None:
        with self.cond:
            self.paused = not self.paused
            self.cond.notify_all()

    def stop(self) -> None:
        with self.cond:
            self.stopping = True
            self.cond.notify_all()

    def eta(self) -> float | None:
        """Seconds left: queued and running sims at the recent average length, spread over the jobs."""
        with self.cond:
            if not self.done:
                return None
            recent = [secs for _, secs, _ in self.done[-30:]]
            avg = sum(recent) / len(recent)
            now = time.monotonic()
            work = len(self.pending) * avg + sum(max(0.0, avg - (now - t0)) for _, t0 in self.running.values())
            return work / self.jobs

    def _work(self, i: int) -> None:
        while True:
            with self.cond:
                while not self.stopping and self.pending and (self.paused or i >= self.jobs):
                    self.cond.wait()
                if self.stopping or not self.pending:
                    return
                task = self.pending.popleft()
                if not self.pending:
                    self.cond.notify_all()  # workers above the job count wait on pending; let them exit
                self.running[i] = (task, time.monotonic())
                jobs = self.jobs
            try:
                value, error = self.run_one(task, jobs), None
            except Exception as e:  # noqa: BLE001 - reported, and the run stops
                value, error = None, f'{e}'
            with self.cond:
                _, t0 = self.running.pop(i)
                if error:
                    self.errors.append((task, error))
                    self.stopping = True  # fail closed: start nothing more; finished specs are saved
                    self.cond.notify_all()
                    return
                name = task.spec['name']
                self.done.append((task, time.monotonic() - t0, value))
                self.results.setdefault(name, {})[(task.targets, task.variant)] = value
                self.left[name] -= 1
                finished = self.left[name] == 0
            if finished:
                try:
                    self.on_spec(task.spec, self.results[name])
                except Exception as e:  # noqa: BLE001
                    with self.cond:
                        self.errors.append((None, f'writing {name}: {e}'))
                        self.stopping = True
                        self.cond.notify_all()
                    return


# ---------------------------------------------------------------------------------------------
# Machine CPU and memory without third-party packages: /proc on Linux, ctypes on macOS and Windows.


class System:
    def __init__(self):
        self.cpu: float | None = None          # percent, whole machine
        self.mem: tuple | None = None          # (used bytes, total bytes)
        self.history: collections.deque = collections.deque(maxlen=240)
        self._prev = None
        try:
            self._times, self._memory = self._probes()
            self.available = True
        except Exception:  # noqa: BLE001 - an unknown platform shows n/a, the sims still run
            self._times = self._memory = lambda: None
            self.available = False

    @staticmethod
    def _probes():
        if sys.platform.startswith('linux'):
            def times():
                with open('/proc/stat') as f:
                    v = [int(x) for x in f.readline().split()[1:9]]
                idle = v[3] + v[4]
                return sum(v) - idle, sum(v)

            def memory():
                info = {}
                with open('/proc/meminfo') as f:
                    for line in f:
                        key, rest = line.split(':', 1)
                        info[key] = int(rest.split()[0]) * 1024
                return info['MemTotal'] - info['MemAvailable'], info['MemTotal']
            return times, memory

        if WINDOWS:
            k32 = ctypes.windll.kernel32

            class Status(ctypes.Structure):
                _fields_ = [('length', ctypes.c_uint32), ('load', ctypes.c_uint32)] + [
                    (n, ctypes.c_uint64) for n in ('total', 'avail', 'page_total', 'page_avail',
                                                   'virt_total', 'virt_avail', 'ext_avail')]

            def times():
                idle, kernel, user = ctypes.c_uint64(), ctypes.c_uint64(), ctypes.c_uint64()
                k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
                total = kernel.value + user.value  # kernel time includes idle time
                return total - idle.value, total

            def memory():
                st = Status()
                st.length = ctypes.sizeof(Status)
                k32.GlobalMemoryStatusEx(ctypes.byref(st))
                return st.total - st.avail, st.total
            return times, memory

        if sys.platform == 'darwin':
            libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
            libc.mach_host_self.restype = ctypes.c_uint
            host = libc.mach_host_self()

            def sysctl(name: bytes) -> int:
                v, n = ctypes.c_uint64(0), ctypes.c_size_t(8)
                libc.sysctlbyname(name, ctypes.byref(v), ctypes.byref(n), None, 0)
                return v.value
            total, page = sysctl(b'hw.memsize'), sysctl(b'hw.pagesize')

            u32, u64 = ctypes.c_uint32, ctypes.c_uint64

            class VM(ctypes.Structure):  # vm_statistics64, mach/vm_statistics.h
                _fields_ = [('free', u32), ('active', u32), ('inactive', u32), ('wire', u32)] + [
                    (n, u64) for n in ('zero_fill', 'reactivations', 'pageins', 'pageouts', 'faults',
                                       'cow_faults', 'lookups', 'hits', 'purges')] + [
                    ('purgeable', u32), ('speculative', u32)] + [
                    (n, u64) for n in ('decompressions', 'compressions', 'swapins', 'swapouts')] + [
                    ('compressor', u32), ('throttled', u32), ('external', u32), ('internal', u32),
                    ('uncompressed_in_compressor', u64)]

            def times():
                t = (ctypes.c_uint32 * 4)()  # user, system, idle, nice (HOST_CPU_LOAD_INFO)
                if libc.host_statistics(host, 3, t, ctypes.byref(ctypes.c_uint32(4))) != 0:
                    return None
                return t[0] + t[1] + t[3], t[0] + t[1] + t[2] + t[3]

            def memory():
                vm = VM()
                count = ctypes.c_uint32(ctypes.sizeof(VM) // 4)
                if libc.host_statistics64(host, 4, ctypes.byref(vm), ctypes.byref(count)) != 0:
                    return None
                # Activity Monitor's "Memory Used": app memory + wired + compressed.
                return (vm.internal - vm.purgeable + vm.wire + vm.compressor) * page, total
            return times, memory

        raise OSError(sys.platform)

    def sample(self) -> None:
        try:
            now = self._times()
            if now and self._prev:
                busy, total = now[0] - self._prev[0], now[1] - self._prev[1]
                if total > 0:
                    self.cpu = 100.0 * busy / total
                    self.history.append(self.cpu)
            self._prev = now or self._prev
            self.mem = self._memory() or self.mem
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------------------------
# Dashboard: plain ANSI, redrawn ~12 times a second on the terminal's alternate screen.

COLOR = 'NO_COLOR' not in os.environ
TRACK = '38;5;237'  # empty bar cells
VARIANT_LABEL = {'base': 'no PI', 'pi': 'PI', 'funnel': 'funnel', 'funnelPi': 'funnel + PI',
                 'aoe': 'AoE build', 'aoePi': 'AoE build + PI'}


def clock(secs: float) -> str:
    secs = int(max(0, secs))
    h, rest = divmod(secs, 3600)
    return f'{h}:{rest // 60:02d}:{rest % 60:02d}' if h else f'{rest // 60}:{rest % 60:02d}'


def gb(n: int) -> str:
    return f'{n / 2**30:.1f}'


class Glyphs:
    def __init__(self, unicode: bool):
        self.blocks = ' ▏▎▍▌▋▊▉█' if unicode else ' ....::::#'
        self.spark = '▁▂▃▄▅▆▇█' if unicode else '_.-~=+*#'
        self.spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' if unicode else '|/-\\'
        # A solid track in dark gray (TRACK) reads better than a shaded glyph, which some fonts draw faintly.
        self.full, self.track, self.pulse = ('█', '█', '▒▓') if unicode else ('#', '.', '+*')
        self.ok, self.bad, self.run, self.wait = ('✓', '✗', '▸', '·') if unicode else ('+', 'x', '>', '.')


def bar(frac: float, width: int, g: Glyphs) -> tuple[str, str]:
    """(filled, empty) strings whose lengths add up to width, with 1/8-cell resolution."""
    frac = min(1.0, max(0.0, frac))
    cells = frac * width
    full = int(cells)
    part = g.blocks[int((cells - full) * 8)] if full < width else ''
    filled = g.full * full + (part if part.strip() else '')
    return filled, g.track * (width - len(filled))


def spark(values, width: int, g: Glyphs) -> str:
    vals = list(values)[-width:]
    return ''.join(g.spark[min(7, int(v / 100 * 8))] for v in vals).rjust(width, g.spark[0])


def paint(parts: list, width: int) -> str:
    """Segments [(text, sgr)] -> one line cut to width (every glyph used here is one cell wide)."""
    out, used = [], 0
    for text, style in parts:
        text = text[:max(0, width - used)]
        if not text:
            break
        used += len(text)
        out.append(f'\x1b[{style}m{text}\x1b[0m' if style and COLOR else text)
    return ''.join(out)


class Dashboard:
    def __init__(self, runner: Runner, system: System, specs: list, cached: set, meta: dict, pool: int,
                 unicode: bool):
        self.r, self.sys, self.specs, self.cached, self.meta, self.pool = runner, system, specs, cached, meta, pool
        self.g = Glyphs(unicode)
        self.shown = 0.0  # eased progress, so the bar glides instead of jumping a run at a time
        self.tick = 0
        self.note = ''

    def lines(self, width: int, height: int) -> list[str]:
        r, g = self.r, self.g
        self.tick += 1
        with r.cond:
            done, running = list(r.done), sorted(r.running.items())
            pending = list(r.pending)
            jobs, paused, stopping, errors = r.jobs, r.paused, r.stopping, list(r.errors)
        now = time.monotonic()
        frac = len(done) / r.total if r.total else 1.0
        self.shown += (frac - self.shown) * 0.2
        eta = r.eta()
        avg = sum(s for _, s, _ in done[-30:]) / len(done[-30:]) if done else None
        w = max(40, width)

        top = []
        e = self.meta['engine']
        top.append(paint([(' Power Infusion data ', '1;30;46'), ('  ', ''),
                          (f"simc {e['simcVersion']} · {e['commit'][:10]} · {self.meta['profiles']} · "
                           f"{self.meta['fightStyle']} · target error {self.meta['targetError']}%", '90')], w))
        top.append('')
        filled, empty = bar(self.shown, min(64, w - 12), g)
        top.append(paint([(' ', ''), (filled, '36'), (empty, TRACK), (f' {frac * 100:5.1f}%', '1')], w))
        status = [(f' {len(done)}/{r.total} sims', '1'),
                  (f' · {sum(1 for s in self.specs if not r.left.get(s["name"]))}/{len(self.specs)} specs', ''),
                  (f' · elapsed {clock(now - r.started)}', '90')]
        if eta is not None:
            finish = datetime.datetime.now() + datetime.timedelta(seconds=eta)
            status += [(' · ', '90'), (f'{clock(eta)} left', '1;33'), (f' (done about {finish:%H:%M})', '90')]
        elif not done:
            status += [(' · time left after the first sim', '90')]
        top.append(paint(status, w))
        machine = [(' CPU ', '90')]
        if self.sys.cpu is not None:
            machine += [(spark(self.sys.history, 24, g), '35'), (f' {self.sys.cpu:3.0f}%', '1')]
        else:
            machine += [('measuring' if self.sys.available else 'n/a', '90')]
        machine += [('    Memory ', '90')]
        if self.sys.mem:
            used, total = self.sys.mem
            f_, e_ = bar(used / total, 16, g)
            machine += [(f_, '34'), (e_, TRACK), (f' {gb(used)} / {gb(total)} GB', '1'),
                        (f' ({used / total * 100:.0f}%)', '90')]
        else:
            machine += [('n/a', '90')]
        top.append(paint(machine, w))
        top.append('')

        head = [(' Running ', '1'), (f'{len(running)}/{jobs} sims side by side × {max(1, self.pool // jobs)} threads', '90')]
        if paused:
            head += [('  PAUSED ', '1;30;43')]
        if stopping and not errors:
            head += [('  STOPPING after the running sims ', '1;30;43')]
        run_lines = [paint(head, w)]
        for i, (task, t0) in running:
            took = now - t0
            if avg:  # how far along, judged by the recent average sim length
                f_, e_ = bar(min(0.99, took / avg), 12, g)
                track = [(f_, '36'), (e_, TRACK)]
            else:  # no timing yet: a marker bouncing along the track
                pos = abs((self.tick + i * 4) % 20 - 10)
                track = [(g.track * pos, TRACK), (g.full * 2, '36'), (g.track * (10 - pos), TRACK)]
            run_lines.append(paint([
                (f' {g.spin[(self.tick + i * 3) % len(g.spin)]} ', '36'),
                (f"{task.spec['name']:<26}", ''), (f'{task.targets:>2}T ', '1'),
                (f'{VARIANT_LABEL[task.variant]:<12}', '90'), *track, (f' {clock(took):>6}', '')], w))
        if not running:
            run_lines.append(paint([('   waiting', '90')], w))
        run_lines.append('')

        # Every spec, one cell per target count: done, running, queued.
        active = {(t.spec['name'], t.targets) for _, (t, _) in running}
        waiting = collections.Counter((t.spec['name'], t.targets) for t in pending)
        failed = {t.spec['name'] for t, _ in errors if t}
        cols = max(1, w // 40)
        cells = []
        for s in self.specs:
            name = s['name']
            is_cached = name in self.cached
            left = r.left.get(name, 0)
            icon, tone = ((g.bad, '31') if name in failed else (g.ok, '32') if is_cached or not left
                          else (g.run, '36') if any(k[0] == name for k in active) else (g.wait, '90'))
            row = [(f' {icon} ', tone), (f'{name[:24]:<24} ', '' if icon != g.wait else '90')]
            for n in TARGETS:
                if is_cached or (not waiting[(name, n)] and (name, n) not in active and name in r.left):
                    row.append((g.full, '2;32' if is_cached else '32'))
                elif (name, n) in active:
                    row.append((g.pulse[(self.tick // 3) % 2], '36'))
                else:
                    row.append((g.track, TRACK))
            cells.append(row)
        rows = (len(cells) + cols - 1) // cols
        grid = [paint([(' Specs ', '1'), ('one cell per target count 1-10: ', '90'), (g.full, '32'), (' done  ', '90'), (g.pulse[1], '36'),
                      (' running  ', '90'), (g.track, TRACK), (' queued', '90')], w)]
        for k in range(rows):
            parts = []
            for c in range(cols):
                idx = c * rows + k
                if idx < len(cells):
                    parts += cells[idx] + [('   ', '')]
            grid.append(paint(parts, w))
        grid.append('')

        recent = [paint([(' Latest ', '1')], w)]
        for task, secs, value in reversed(done[-8:]):
            recent.append(paint([(f' {g.ok} ', '32'), (f"{task.spec['name']:<26}", ''),
                                 (f'{task.targets:>2}T ', '1'), (f'{VARIANT_LABEL[task.variant]:<12}', '90'),
                                 (f'{value[0]["dps"][0]:>12,.0f} DPS', ''), (f'  {secs:5.1f}s', '90')], w))
        for task, message in errors:
            where = f"{task.spec['name']} {task.targets}T {VARIANT_LABEL[task.variant]}: " if task else ''
            recent.append(paint([(f' {g.bad} {where}', '1;31'), (message.splitlines()[0] if message else '', '31')], w))

        keys = [(' p ', '1;30;47'), (' resume ' if paused else ' pause ', '90'),
                (' + ', '1;30;47'), (' - ', '1;30;47'), (f' sims side by side ({jobs}) ', '90'),
                (' q ', '1;30;47'), (' stop now ' if stopping else ' stop after running sims ', '90')]
        if self.note:
            keys += [(f'  {self.note}', '33')]
        foot = ['', paint(keys, w)]

        # Never taller than the terminal, or each frame scrolls instead of redrawing. Short
        # terminals lose blank lines first, then the latest sims, then spec rows, then running rows.
        body = grid + recent
        if len(top) + len(run_lines) + len(body) + len(foot) > height:
            top, run_lines, foot = [x for x in top if x], [x for x in run_lines if x], foot[-1:]
            body = [x for x in body if x]
        room = height - len(top) - len(foot)
        run_lines = run_lines[:max(1, room)]
        room -= len(run_lines)
        return (top + run_lines + body[:max(0, room)])[:max(0, height - len(foot))] + foot


class Terminal:
    """Alternate screen, hidden cursor, single-key input without Enter; everything restored on exit."""

    def __enter__(self):
        self.fd, self.saved = None, None
        if WINDOWS:
            k32 = ctypes.windll.kernel32
            handle, mode = k32.GetStdHandle(-11), ctypes.c_uint32()
            if k32.GetConsoleMode(handle, ctypes.byref(mode)):
                k32.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        elif sys.stdin.isatty():
            import termios
            import tty
            self.fd = sys.stdin.fileno()
            self.saved = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)  # keys arrive one at a time; Ctrl-C still interrupts
        sys.stdout.write('\x1b[?1049h\x1b[?25l')
        sys.stdout.flush()
        return self

    def __exit__(self, *exc):
        sys.stdout.write('\x1b[?25h\x1b[?1049l')
        sys.stdout.flush()
        if self.saved is not None:
            import termios
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)

    def key(self) -> str | None:
        if WINDOWS:
            import msvcrt
            return msvcrt.getwch() if msvcrt.kbhit() else None
        if self.fd is None:
            return None
        import select
        if select.select([self.fd], [], [], 0)[0]:
            return os.read(self.fd, 1).decode(errors='ignore')
        return None

    @staticmethod
    def draw(lines: list[str]) -> None:
        sys.stdout.write('\x1b[H' + '\x1b[K\n'.join(lines) + '\x1b[K\x1b[J')
        sys.stdout.flush()


def watch_dashboard(runner: Runner, dash: Dashboard, system: System) -> None:
    quit_presses = 0
    last_sample = 0.0
    with Terminal() as term:
        while runner.alive():
            if time.monotonic() - last_sample >= 1:
                system.sample()
                last_sample = time.monotonic()
            key = term.key()
            while key:
                if key in 'pP':
                    runner.pause()
                elif key in '+=':
                    runner.set_jobs(runner.jobs + 1)
                elif key in '-_':
                    runner.set_jobs(runner.jobs - 1)
                elif key in 'qQ':
                    quit_presses += 1
                    runner.stop()
                    if quit_presses > 1:
                        kill_engines()
                    dash.note = 'stopping now' if quit_presses > 1 else 'press q again to stop the running sims too'
                key = term.key()
            size = shutil.get_terminal_size((100, 40))
            term.draw(dash.lines(size.columns, size.lines))
            time.sleep(0.08)


def watch_plain(runner: Runner) -> None:
    seen = 0
    while runner.alive():
        time.sleep(0.5)
        with runner.cond:
            new, seen = runner.done[seen:], len(runner.done)
        for task, secs, _ in new:
            eta = runner.eta()
            print(f"[{seen / runner.total * 100:5.1f}%] {task.spec['name']} @ {task.targets}T "
                  f"{VARIANT_LABEL[task.variant]}: {secs:.0f}s" + (f', {clock(eta)} left' if eta else ''), flush=True)


# ---------------------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--target-error', type=float, default=0.1)
    ap.add_argument('--jobs', type=int, default=3,
                    help='sims side by side; each engine run is ~2/3 single-threaded startup')
    ap.add_argument('--tier', default='MID2', help='profiles/<tier> directory in vendor/simc')
    ap.add_argument('--specs', default='', help='comma-separated display names, for partial runs')
    ap.add_argument('--out', type=Path, default=OUT, help='output JSON (default: the file the app bundles)')
    ap.add_argument('--variants', default=','.join(PAIRS),
                    help=f'comma-separated pairs to run ({", ".join(PAIRS)}); a partial run needs --out and a merge')
    ap.add_argument('--plain', action='store_true', help='one line per sim instead of the live dashboard')
    opts = ap.parse_args()
    out = opts.out.resolve()
    only = tuple(v.strip() for v in opts.variants.split(',') if v.strip())
    if not only or set(only) - set(PAIRS):
        sys.exit(f'--variants takes {", ".join(PAIRS)}')
    if set(only) != set(PAIRS) and out == OUT.resolve():
        sys.exit('a --variants run is partial: write it with --out pi-runs/<name>/power-infusion.json and merge it in')
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except (OSError, ValueError):
            pass

    lock = json.loads((ROOT / 'engine.lock.json').read_text())
    manifest = json.loads((ROOT / 'public/engine/manifest.json').read_text())
    preflight(lock, manifest)
    pool = manifest['capabilities']['pthreadPoolSize']
    node = shutil.which('node')
    if not node:
        sys.exit('node not found on PATH (Node >= 26, see .nvmrc)')

    profile_dir = ROOT / 'vendor/simc/profiles' / opts.tier
    if not profile_dir.is_dir():
        sys.exit(f'no profile directory {profile_dir}')
    files = [(p.name, p.read_text()) for p in sorted(profile_dir.glob('*.simc'))]
    specs = pick_profiles(files)
    only = [s.strip() for s in opts.specs.split(',') if s.strip()]
    if only:
        known = {s['name'] for s in specs}
        unknown = [n for n in only if n not in known]
        if unknown:
            sys.exit(f'unknown spec(s): {", ".join(unknown)}. Known: {", ".join(sorted(known))}')
        specs = [s for s in specs if s['name'] in only]

    meta = {
        'schemaVersion': 1,
        'engine': {
            'commit': lock['upstream']['commit'],
            'simcVersion': lock['expected']['simcVersion'],
            'wowVersion': lock['expected']['clientDataWowVersion'],
        },
        'profiles': opts.tier,
        'fightStyle': FIGHT_STYLE,
        'targetError': opts.target_error,
    }
    detail_dir = out.parent / DETAIL
    detail_dir.mkdir(parents=True, exist_ok=True)
    detail_path = lambda spec: detail_dir / f"{DETAIL}-{spec['profile']}.json"

    def current(path: Path) -> dict | None:
        prev = json.loads(path.read_text()) if path.exists() else None
        return prev if prev is not None and all(prev.get(k) == meta[k] for k in meta) else None

    prev = current(out)
    if prev and prev.get('merged'):
        sys.exit(f'{out} is a merge of several runs (scripts/merge_power_infusion.py). Write new runs\n'
                 'somewhere else, e.g. --out pi-runs/<machine>/power-infusion.json, and merge them in.')
    # Old chart rows stay until replaced, so the bundled file is never partial mid-run.
    done = {s['name']: s for s in prev['specs']} if prev else {}
    lock_out = threading.Lock()

    def write(path: Path, data: dict, indent: int | None) -> None:
        tmp = path.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(data, indent=indent, separators=None if indent else (',', ':')) + '\n')
        for attempt in range(10):
            try:
                os.replace(tmp, path)  # atomic: a build mid-run never reads a half-written file
                return
            except PermissionError:  # Windows: a reader (the dev server) briefly holds the file
                if attempt == 9:
                    raise
                time.sleep(0.2)

    def save() -> None:
        with lock_out:
            write(out, dict(meta, generatedAt=datetime.date.today().isoformat(),
                            specs=[done[k] for k in sorted(done)]), 1)

    # A spec is finished only when its drawer file is from the same engine and settings too.
    finished = {s['name'] for s in specs if s['name'] in done and current(detail_path(s))}
    queue = [s for s in specs if s['name'] not in finished]
    if not queue:
        print('nothing to do: every spec is current')
        return

    relink(pool)
    work = Path(tempfile.mkdtemp(prefix='frostsim-pi-'))

    def run_one(task: Task, jobs: int) -> tuple[dict, dict]:
        spec, n, v = task
        json_path = work / f"{spec['profile']}-{n}-{v}.json"
        code, output = engine(node, run_args(
            spec, n, v, target_error=opts.target_error, threads=max(1, pool // jobs),
            profile_path=(profile_dir / f"{spec['profile']}.simc").as_posix(), json_path=json_path.as_posix()))
        if code != 0:
            tail = '\n'.join(output.strip().splitlines()[-5:])
            raise RuntimeError(f'engine exit {code}:\n{tail}')
        report = json.loads(json_path.read_text())
        check_engine(report, meta['engine']['commit'], meta['engine']['simcVersion'])
        result = extract_variant(report)
        json_path.unlink()
        return result

    def on_spec(spec: dict, results: dict) -> None:
        runs, details = [], []
        for n in TARGETS:
            run, detail = {'targets': n}, {'targets': n}
            for v in variants(spec, n, only):
                run[v], detail[v] = results[(n, v)]
            runs.append(run)
            details.append(detail)
        write(detail_path(spec), dict(meta, profile=spec['profile'], runs=details), None)
        with lock_out:
            done[spec['name']] = dict(spec, runs=runs)
        save()

    tasks = [Task(s, n, v) for s in queue for n in TARGETS for v in variants(s, n, only)]
    runner = Runner(tasks, run_one, on_spec, opts.jobs, max_jobs=pool).start()
    system = System()
    plain = opts.plain or not sys.stdout.isatty() or os.environ.get('TERM') == 'dumb'
    unicode = (sys.stdout.encoding or '').lower().replace('-', '') == 'utf8'
    try:
        if plain:
            for name in sorted(finished):
                print(f'{name}: current, skipped')
            watch_plain(runner)
        else:
            watch_dashboard(runner, Dashboard(runner, system, specs, finished, meta, pool, unicode), system)
    except KeyboardInterrupt:
        runner.stop()
        kill_engines()
        for w in runner.workers:
            w.join()
        sys.exit(f'\ninterrupted. {len(done)} specs saved to {out}; rerun to continue.')
    for w in runner.workers:
        w.join()

    took = clock(time.monotonic() - runner.started)
    if runner.errors:
        for task, message in runner.errors:
            where = f"{task.spec['name']} @ {task.targets}T {VARIANT_LABEL[task.variant]}" if task else 'write'
            print(f'FAILED {where}: {message}', file=sys.stderr)
        sys.exit(f'stopped after {took}. Finished specs are saved; rerun to continue.')
    if runner.pending:
        sys.exit(f'stopped after {took} with {len(runner.pending)} sims left. Finished specs are saved; rerun to continue.')
    save()
    print(f'wrote {out} ({len(done)} specs) and {DETAIL}/ in {took}')


if __name__ == '__main__':
    main()
